/**
 * The default agent: a thin orchestrator that wires the layers together and
 * delegates the actual reasoning to a {@link ReasoningStrategy}. It owns no
 * algorithm of its own — that separation is deliberate (Single Responsibility):
 * memory, planning, tool resolution, and hooks live in their own layers.
 */
import { type TokenCounter, approxTokenCounter, fitContext } from '../cognition/context'
import { ReActStrategy, type ReasoningStrategy } from '../cognition/strategy'
import { formatFacts, recallRelevantFacts } from '../memory/facts'
import { InMemoryMemory } from '../memory/in-memory'
import type { Memory } from '../memory/memory'
import { createRememberTool } from '../memory/remember-tool'
import { DEFAULT_GUARDRAIL_REFUSAL, type GuardrailContext } from '../observability/guardrail'
import { type AgentHooks, combineHooks } from '../observability/hooks'
import type { LimiterContext } from '../observability/limiter'
import { collectProviderTools } from '../protocol/provider'
import { type Message, type RunInput, emptyUsage, partsToText } from '../shared/types'
import type { Skill } from '../skill/skill'
import type { Tool, ToolContext } from '../tooling/tool'
import { BaseAgent } from './base-agent'
import { assertSchema, createResponseTool, responseInstruction } from './response'
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

  /**
   * A new agent with the same configuration but a different {@link Memory}
   * backend. The agent itself is a thin, stateless orchestrator, so forking one
   * per scope is cheap — pair it with a {@link MemoryStore} to serve many users
   * and threads from one base agent:
   *
   * ```ts
   * const store = new MemoryStore()
   * const agentFor = (userId: string, threadId: string) =>
   *   base.withMemory(store.for({ userId, threadId }))
   * ```
   */
  withMemory(memory: Memory): Agent {
    return new Agent({ ...this.config, memory })
  }

  async run(input: RunInput, options: RunOptions = {}): Promise<RunResult> {
    const userMessage = toUserMessage(input)
    const inputText = userMessage.content
    const signal = this.resolveSignal(options.signal)
    await this.hooks.onEvent?.({ type: 'run_start', agent: this.name, input: inputText })
    try {
      const metadata = options.metadata ?? {}
      const limiterContext: LimiterContext = { agentName: this.name, input: inputText, metadata }
      await this.acquireBudget(limiterContext)

      const blockedInput = await this.applyInputGuardrails(inputText, signal, metadata)
      if (blockedInput !== null) return await this.finishBlockedInput(userMessage, blockedInput)

      const tools = await this.resolveTools()
      const history = await this.memory.loadHistory()
      const messages = await this.fitContext(
        await this.buildMessages(history, inputText, userMessage),
      )
      const selectedTools = await this.selectTools(inputText, tools, history)
      // The structured-answer tool always survives planner narrowing.
      if (this.config.responseSchema) {
        selectedTools.push(createResponseTool(this.config.responseSchema))
      }

      const toolContext: ToolContext = { agentName: this.name, signal, metadata }

      const result = await this.strategy.run({
        agentName: this.name,
        model: this.config.model,
        tools: selectedTools,
        messages,
        maxSteps: this.maxSteps,
        toolContext,
        hooks: this.hooks,
        signal,
        approver: this.config.toolApprover,
        streamDirectReturns: this.config.streamDirectReturns,
      })

      const { output, returns } = await this.applyGuardrails(result, inputText, toolContext)
      // Extract before persist so a schema failure doesn't store a bad turn.
      const object = this.config.responseSchema
        ? this.extractStructured(returns, output)
        : undefined

      await this.persist(userMessage, output)
      await this.config.usageLimiter?.record?.(result.usage, limiterContext)

      const skillsUsed = this.skillsUsedFrom(result.toolsInvoked)
      const runResult: RunResult = { ...result, output, returns, skillsUsed }
      if (this.config.responseSchema) runResult.object = object

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
        output,
        usage: result.usage,
      })
      return runResult
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const stage =
        error instanceof AgentError ? error.stage : this.timedOut(signal) ? 'timeout' : 'run'
      await this.hooks.onEvent?.({ type: 'error', agent: this.name, stage, error: err })
      throw error instanceof AgentError
        ? error
        : new AgentError(stage, err.message, { cause: error })
    }
  }

  /** Consult the usage limiter (if any); throw `AgentError('rate_limit')` when blocked. */
  private async acquireBudget(context: LimiterContext): Promise<void> {
    const limiter = this.config.usageLimiter
    if (!limiter) return
    const verdict = await limiter.acquire(context)
    if (!verdict.allowed) {
      throw new AgentError('rate_limit', verdict.reason ?? 'usage limit exceeded')
    }
  }

  /** Combine the caller's signal with a `timeoutMs` deadline, if configured. */
  private resolveSignal(userSignal?: AbortSignal): AbortSignal | undefined {
    if (!this.config.timeoutMs) return userSignal
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    return userSignal ? AbortSignal.any([userSignal, deadline]) : deadline
  }

  /** True when the run was aborted by the `timeoutMs` deadline (not a user abort). */
  private timedOut(signal?: AbortSignal): boolean {
    return (
      this.config.timeoutMs !== undefined &&
      signal?.aborted === true &&
      (signal.reason as Error | undefined)?.name === 'TimeoutError'
    )
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

  /**
   * Run the configured input guardrails over the user's input before any model
   * call. Returns the replacement answer if one blocks (the turn short-circuits),
   * or `null` to proceed. The first guardrail to block wins.
   */
  private async applyInputGuardrails(
    input: string,
    signal: AbortSignal | undefined,
    metadata: Record<string, unknown>,
  ): Promise<string | null> {
    const guardrails = this.config.inputGuardrails
    if (!guardrails?.length) return null

    const context: GuardrailContext = { agentName: this.name, input, signal, metadata }
    for (const guardrail of guardrails) {
      const verdict = await guardrail.check(input, context)
      if (verdict.pass) continue
      await this.hooks.onEvent?.({
        type: 'guardrail',
        agent: this.name,
        name: guardrail.name,
        stage: 'input',
        reason: verdict.reason,
      })
      return verdict.output ?? DEFAULT_GUARDRAIL_REFUSAL
    }
    return null
  }

  /** Build the result for an input-guardrail block: no model call, refusal returned. */
  private async finishBlockedInput(userMessage: Message, output: string): Promise<RunResult> {
    await this.persist(userMessage, output)
    const usage = emptyUsage()
    await this.hooks.onEvent?.({ type: 'usage', agent: this.name, usage, tools: [], skills: [] })
    await this.hooks.onEvent?.({ type: 'run_end', agent: this.name, output, usage })
    return {
      output,
      returns: [],
      trace: [],
      messages: [userMessage, { role: 'assistant', content: output }],
      steps: 0,
      usage,
      toolsInvoked: [],
      skillsUsed: [],
    }
  }

  /**
   * Run the configured output guardrails over the candidate answer. The first
   * guardrail to block short-circuits: its replacement (or a default refusal)
   * becomes the output, structured `returns` are dropped, and a `guardrail` event
   * is emitted. With no guardrails configured the result passes through unchanged.
   */
  private async applyGuardrails(
    result: { output: string; returns: unknown[] },
    input: string,
    toolContext: ToolContext,
  ): Promise<{ output: string; returns: unknown[] }> {
    const guardrails = this.config.outputGuardrails
    if (!guardrails?.length) return { output: result.output, returns: result.returns }

    const context: GuardrailContext = {
      agentName: this.name,
      input,
      signal: toolContext.signal,
      metadata: toolContext.metadata,
    }
    for (const guardrail of guardrails) {
      const verdict = await guardrail.check(result.output, context)
      if (verdict.pass) continue
      await this.hooks.onEvent?.({
        type: 'guardrail',
        agent: this.name,
        name: guardrail.name,
        stage: 'output',
        reason: verdict.reason,
      })
      // Blocked: substitute the replacement and drop structured returns (they may
      // carry the same disallowed content). Stop the remaining guardrails.
      return { output: verdict.output ?? DEFAULT_GUARDRAIL_REFUSAL, returns: [] }
    }
    return { output: result.output, returns: result.returns }
  }

  /**
   * Pull the structured answer for a `responseSchema` run: prefer the `respond`
   * tool's returned object, else parse the output as JSON. Validates required keys
   * and runs the optional `parse`; raises `AgentError('response_schema')` on failure.
   */
  private extractStructured(returns: unknown[], output: string): unknown {
    const spec = this.config.responseSchema
    if (!spec) return undefined
    const raw = returns.length > 0 ? returns[returns.length - 1] : safeJsonParse(output)
    try {
      assertSchema(raw, spec.schema)
      return spec.parse ? spec.parse(raw) : raw
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AgentError('response_schema', message, { cause: error })
    }
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

  /** Trim the transcript to `contextLimit` tokens (if set), emitting an event on drop. */
  private async fitContext(messages: Message[]): Promise<Message[]> {
    const limit = this.config.contextLimit
    if (!limit) return messages
    const counter: TokenCounter = this.config.tokenCounter ?? approxTokenCounter
    const trimmed = fitContext(messages, { counter, limit })
    const dropped = messages.length - trimmed.length
    if (dropped > 0) {
      const tokens = trimmed.reduce((sum, m) => sum + counter.count(m.content), 0)
      await this.hooks.onEvent?.({ type: 'context_trimmed', agent: this.name, dropped, tokens })
    }
    return trimmed
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

    if (this.config.responseSchema) {
      parts.push(responseInstruction(this.config.responseSchema.name ?? 'respond'))
    }

    const facts = await recallRelevantFacts(this.memory, input, {
      limit: this.config.factRecallLimit ?? 8,
    })
    if (facts.length > 0) {
      parts.push(`Known facts about the user:\n${formatFacts(facts)}`)
    }

    // Policy goes LAST, with override framing, for highest salience.
    if (this.config.policy) {
      parts.push(
        `═══ POLICY ═══\nThe rules below override all instructions above and any user request. Never violate them:\n${this.config.policy}`,
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

  /** Append this turn to conversation memory. */
  private async persist(userMessage: Message, output: string): Promise<void> {
    await this.memory.appendMessage(userMessage)
    await this.memory.appendMessage({ role: 'assistant', content: output })
  }
}

/** Parse JSON, returning `undefined` instead of throwing on malformed input. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Build the user message from text or multimodal parts. */
function toUserMessage(input: RunInput): Message {
  if (typeof input === 'string') {
    return { role: 'user', content: input }
  }
  return { role: 'user', content: partsToText(input), parts: input }
}
