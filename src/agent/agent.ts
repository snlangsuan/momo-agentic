/**
 * The default agent: a thin orchestrator that wires the layers together and
 * delegates the actual reasoning to a {@link ReasoningStrategy}. It owns no
 * algorithm of its own — that separation is deliberate (Single Responsibility):
 * memory, planning, tool resolution, and hooks live in their own layers.
 */
import { ReActStrategy, type ReasoningStrategy } from '../cognition/strategy'
import { InMemoryMemory } from '../memory/in-memory'
import type { Memory, MemoryFact } from '../memory/memory'
import { createRememberTool } from '../memory/remember-tool'
import { type AgentHooks, combineHooks } from '../observability/hooks'
import { collectProviderTools } from '../protocol/provider'
import { type Message, type RunInput, partsToText } from '../shared/types'
import type { Skill } from '../skill/skill'
import type { Tool, ToolContext } from '../tooling/tool'
import { BaseAgent } from './base-agent'
import type { AgentConfig, RunOptions, RunResult } from './types'

/** Raised when a run fails, tagged with the stage that failed. */
export class AgentError extends Error {
  readonly stage: string
  constructor(stage: string, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'AgentError'
    this.stage = stage
    if (options?.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

export class Agent extends BaseAgent {
  readonly name: string
  private readonly config: AgentConfig
  private readonly strategy: ReasoningStrategy
  private readonly memory: Memory
  private readonly hooks: AgentHooks
  private readonly maxSteps: number
  private readonly skills: Skill[]
  /** Maps a tool name to the skill that provided it, for usage attribution. */
  private readonly toolToSkill: Map<string, string>

  constructor(config: AgentConfig) {
    super()
    this.config = config
    this.name = config.name ?? 'agent'
    this.strategy = config.strategy ?? new ReActStrategy()
    this.memory = config.memory ?? new InMemoryMemory()
    this.hooks = combineHooks(config.hooks)
    this.maxSteps = config.maxSteps ?? 10
    this.skills = config.skills ?? []
    this.toolToSkill = new Map(
      this.skills.flatMap((skill) => skill.tools.map((tool) => [tool.name, skill.name] as const)),
    )
  }

  async run(input: RunInput, options: RunOptions = {}): Promise<RunResult> {
    const userMessage = toUserMessage(input)
    const inputText = userMessage.content
    await this.hooks.onEvent?.({ type: 'run_start', agent: this.name, input: inputText })
    try {
      const tools = await this.resolveTools()
      const history = await this.memory.loadHistory()
      const messages = await this.buildMessages(history, inputText, userMessage)
      const selectedTools = await this.selectTools(inputText, tools, history)

      const toolContext: ToolContext = {
        agentName: this.name,
        signal: options.signal,
        metadata: options.metadata ?? {},
      }

      const result = await this.strategy.run({
        agentName: this.name,
        model: this.config.model,
        tools: selectedTools,
        messages,
        maxSteps: this.maxSteps,
        toolContext,
        hooks: this.hooks,
        signal: options.signal,
        streamDirectReturns: this.config.streamDirectReturns,
      })

      await this.persist(userMessage, result.output)

      const skillsUsed = this.skillsUsedFrom(result.toolsInvoked)
      const runResult: RunResult = { ...result, skillsUsed }

      await this.hooks.onEvent?.({
        type: 'usage',
        agent: this.name,
        usage: result.usage,
        tools: result.toolsInvoked,
        skills: skillsUsed,
      })
      await this.hooks.onEvent?.({
        type: 'run_end',
        agent: this.name,
        output: result.output,
        usage: result.usage,
      })
      return runResult
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this.hooks.onEvent?.({ type: 'error', agent: this.name, stage: 'run', error: err })
      throw error instanceof AgentError
        ? error
        : new AgentError('run', err.message, { cause: error })
    }
  }

  /**
   * Local tools, every skill's tools, an optional `remember_fact` tool
   * (long-term write), and any tools resolved from protocol providers (Layer 3).
   */
  private async resolveTools(): Promise<Tool[]> {
    const tools: Tool[] = [...(this.config.tools ?? [])]
    for (const skill of this.skills) {
      tools.push(...skill.tools)
    }
    if (this.config.rememberFacts && this.memory.rememberFact) {
      tools.push(createRememberTool({ rememberFact: this.memory.rememberFact.bind(this.memory) }))
    }
    if (this.config.toolProviders?.length) {
      tools.push(...(await collectProviderTools(this.config.toolProviders)))
    }
    return tools
  }

  /** Deduped skill names whose tools appear among the invoked tools. */
  private skillsUsedFrom(toolsInvoked: string[]): string[] {
    const used = new Set<string>()
    for (const name of toolsInvoked) {
      const skill = this.toolToSkill.get(name)
      if (skill) used.add(skill)
    }
    return [...used]
  }

  /** Apply the optional planner to narrow the toolset for this turn. */
  private async selectTools(input: string, tools: Tool[], history: Message[]): Promise<Tool[]> {
    if (!this.config.planner) return tools
    const plan = await this.config.planner.plan(input, {
      agentName: this.name,
      history,
      availableTools: tools.map((t) => t.name),
    })
    await this.hooks.onEvent?.({
      type: 'plan',
      agent: this.name,
      mode: plan.mode,
      tools: plan.tools,
      reason: plan.reason,
    })
    if (plan.mode === 'respond') return []
    if (plan.mode === 'use_tools' && plan.tools) {
      const wanted = new Set(plan.tools)
      return tools.filter((t) => wanted.has(t.name))
    }
    return tools
  }

  /** Compose the system message (persona + rules + recalled facts) and turn. */
  private async buildMessages(
    history: Message[],
    inputText: string,
    userMessage: Message,
  ): Promise<Message[]> {
    const messages: Message[] = []
    const system = await this.buildSystemPrompt(inputText)
    if (system) messages.push({ role: 'system', content: system })
    messages.push(...history)
    messages.push(userMessage)
    return messages
  }

  private async buildSystemPrompt(input: string): Promise<string> {
    const parts: string[] = []
    if (this.config.persona) parts.push(this.config.persona)
    if (this.config.instructions) parts.push(this.config.instructions)

    const skillCatalog = this.buildSkillCatalog()
    if (skillCatalog) parts.push(skillCatalog)

    const facts = await this.recallRelevantFacts(input)
    if (facts.length > 0) {
      parts.push(
        `Known facts about the user:\n${facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')}`,
      )
    }
    return parts.join('\n\n')
  }

  /** Render each configured skill's guidance into a system-prompt section. */
  private buildSkillCatalog(): string {
    if (this.skills.length === 0) return ''
    const blocks = this.skills.map((skill) => {
      const desc = skill.description ? `${skill.description}\n` : ''
      return `═══ ${skill.name} ═══\n${desc}${skill.instruction}`
    })
    return `Available skills (capabilities you can use via their tools):\n\n${blocks.join('\n\n')}`
  }

  /**
   * Pull long-term facts for this turn. When the whole fact set fits within
   * `factRecallLimit`, inject all of it (so always-relevant facts like the
   * user's name are never dropped). Only when facts exceed the limit does the
   * backend's semantic `searchFacts` rank by relevance to `input`.
   */
  private async recallRelevantFacts(input: string): Promise<MemoryFact[]> {
    const limit = this.config.factRecallLimit ?? 8
    if (this.memory.recallFacts) {
      const entries = Object.entries(await this.memory.recallFacts())
      if (entries.length <= limit) {
        return entries.map(([key, value]) => ({ key, value }))
      }
      if (this.memory.searchFacts) {
        return this.memory.searchFacts(input, { limit })
      }
      return entries.slice(0, limit).map(([key, value]) => ({ key, value }))
    }
    // Backend exposes only semantic search (no full recall).
    if (this.memory.searchFacts) {
      return this.memory.searchFacts(input, { limit })
    }
    return []
  }

  /** Append this turn to conversation memory. */
  private async persist(userMessage: Message, output: string): Promise<void> {
    await this.memory.appendMessage(userMessage)
    await this.memory.appendMessage({ role: 'assistant', content: output })
  }
}

/** Build the user message from text or multimodal parts. */
function toUserMessage(input: RunInput): Message {
  if (typeof input === 'string') {
    return { role: 'user', content: input }
  }
  return { role: 'user', content: partsToText(input), parts: input }
}
