import { BaseAgent } from '@/agent/base-agent'
import {
  RESPONSE_TOOL_NAME,
  assertSchema,
  createResponseTool,
  repairInstruction,
  responseInstruction,
} from '@/agent/response'
import type { AgentConfig, RunOptions, RunResult } from '@/agent/types'
/**
 * The default agent: a thin orchestrator that wires the layers together and
 * delegates the actual reasoning to a {@link ReasoningStrategy}. It owns no
 * algorithm of its own — that separation is deliberate (Single Responsibility):
 * memory, planning, tool resolution, and hooks live in their own layers.
 */
import { type TokenCounter, approxTokenCounter, fitContext } from '@/cognition/context'
import {
  ReActStrategy,
  type ReasoningInput,
  type ReasoningResult,
  type ReasoningStrategy,
  type StepTrace,
} from '@/cognition/strategy'
import { formatFacts, recallRelevantFacts } from '@/memory/facts'
import { InMemoryMemory } from '@/memory/in-memory'
import type { Memory } from '@/memory/memory'
import { createRememberTool } from '@/memory/remember-tool'
import { DEFAULT_GUARDRAIL_REFUSAL, type GuardrailContext } from '@/observability/guardrail'
import { type AgentHooks, combineHooks } from '@/observability/hooks'
import type { LimiterContext } from '@/observability/limiter'
import { collectProviderTools } from '@/protocol/provider'
import {
  type Message,
  type RunInput,
  type Usage,
  addUsage,
  emptyUsage,
  partsToText,
} from '@/shared/types'
import type { Skill } from '@/skill/skill'
import type { Tool, ToolContext } from '@/tooling/tool'

/** The per-step checkpoint writer accepted by the reasoning strategy. */
type ReasoningStepHook = NonNullable<ReasoningInput['onStep']>

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
    // Combine the agent's hooks with any per-run hooks for THIS run only.
    const hooks = this.resolveHooks(options.hooks)
    await hooks.onEvent?.({ type: 'run_start', agent: this.name, input: inputText })
    try {
      const metadata = options.metadata ?? {}
      const limiterContext: LimiterContext = { agentName: this.name, input: inputText, metadata }
      await this.acquireBudget(limiterContext)

      const blockedInput = await this.applyInputGuardrails(inputText, signal, metadata, hooks)
      if (blockedInput !== null) {
        return await this.finishBlockedInput(userMessage, blockedInput, hooks)
      }

      const tools = await this.resolveTools()
      const history = await this.memory.loadHistory()
      const selectedTools = await this.selectTools(inputText, tools, history, hooks)
      // The structured-answer tool always survives planner narrowing.
      if (this.config.responseSchema) {
        selectedTools.push(createResponseTool(this.config.responseSchema))
      }

      // Durable runs: resume from a checkpoint if one exists, else a fresh
      // transcript, plus the per-step checkpoint writer. Enabled by a `runId`.
      const durable = await this.prepareDurableRun(options, history, inputText, userMessage, hooks)

      const toolContext: ToolContext = { agentName: this.name, signal, metadata }

      const reasoningInput: ReasoningInput = {
        agentName: this.name,
        model: this.config.model,
        tools: selectedTools,
        messages: durable.messages,
        maxSteps: this.maxSteps,
        toolContext,
        hooks,
        signal,
        approver: this.config.toolApprover,
        streamDirectReturns: this.config.streamDirectReturns,
        resume: durable.resume,
        onStep: durable.onStep,
      }
      let result = await this.strategy.run(reasoningInput)
      // Structured output: optionally re-ask the model to fix an invalid answer.
      result = await this.repairStructured(result, reasoningInput, hooks)

      const { output, returns } = await this.applyGuardrails(result, inputText, toolContext, hooks)
      // Extract before persist so a schema failure doesn't store a bad turn.
      const object = this.config.responseSchema
        ? this.extractStructured(returns, output)
        : undefined

      await this.persist(userMessage, output)
      await this.config.usageLimiter?.record?.(result.usage, limiterContext)
      await this.clearCheckpoint(options) // run completed → checkpoint no longer needed

      const skillsUsed = this.skillsUsedFrom(result.toolsInvoked)
      const usageByModel = aggregateUsageByModel(result.trace)
      const runResult: RunResult = { ...result, output, returns, skillsUsed, usageByModel }
      if (this.config.responseSchema) runResult.object = object

      await hooks.onEvent?.({
        type: 'usage',
        agent: this.name,
        usage: result.usage,
        tools: result.toolsInvoked,
        skills: skillsUsed,
      })
      await hooks.onEvent?.({
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
      await hooks.onEvent?.({ type: 'error', agent: this.name, stage, error: err })
      throw error instanceof AgentError
        ? error
        : new AgentError(stage, err.message, { cause: error })
    }
  }

  /**
   * Resolve the working transcript for the run plus its durable-run wiring. On a
   * `{ runId, resume }` with an existing checkpoint, the saved transcript +
   * accumulators are restored; otherwise the transcript is built fresh. When a
   * `runId` is given (with a `runStore`), an `onStep` writer checkpoints each step.
   */
  private async prepareDurableRun(
    options: RunOptions,
    history: Message[],
    inputText: string,
    userMessage: Message,
    hooks: AgentHooks,
  ): Promise<{
    messages: Message[]
    resume?: { step: number; usage: Usage; toolsInvoked: string[] }
    onStep?: ReasoningStepHook
  }> {
    const store = this.config.runStore
    const runId = options.runId
    const checkpoint = store && runId && options.resume ? await store.load(runId) : undefined
    const resuming = checkpoint?.status === 'running' ? checkpoint : undefined

    const messages = resuming
      ? resuming.messages
      : await this.fitContext(await this.buildMessages(history, inputText, userMessage), hooks)

    const onStep: ReasoningStepHook | undefined =
      store && runId
        ? (snap) => store.save({ runId, input: inputText, status: 'running', ...snap })
        : undefined

    return {
      messages,
      resume: resuming
        ? { step: resuming.step, usage: resuming.usage, toolsInvoked: resuming.toolsInvoked }
        : undefined,
      onStep,
    }
  }

  /** Delete a completed run's checkpoint, if durable runs are enabled for it. */
  private async clearCheckpoint(options: RunOptions): Promise<void> {
    if (this.config.runStore && options.runId) {
      await this.config.runStore.delete(options.runId)
    }
  }

  /** Merge the agent's hooks with optional per-run hooks (config hooks first). */
  private resolveHooks(perRun?: AgentHooks): AgentHooks {
    return perRun ? combineHooks(this.hooks, perRun) : this.hooks
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
    hooks: AgentHooks,
  ): Promise<string | null> {
    const guardrails = this.config.inputGuardrails
    if (!guardrails?.length) return null

    const context: GuardrailContext = { agentName: this.name, input, signal, metadata }
    for (const guardrail of guardrails) {
      const verdict = await guardrail.check(input, context)
      if (verdict.pass) continue
      await hooks.onEvent?.({
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
  private async finishBlockedInput(
    userMessage: Message,
    output: string,
    hooks: AgentHooks,
  ): Promise<RunResult> {
    await this.persist(userMessage, output)
    const usage = emptyUsage()
    await hooks.onEvent?.({ type: 'usage', agent: this.name, usage, tools: [], skills: [] })
    await hooks.onEvent?.({ type: 'run_end', agent: this.name, output, usage })
    return {
      output,
      returns: [],
      trace: [],
      messages: [userMessage, { role: 'assistant', content: output }],
      steps: 0,
      usage,
      usageByModel: {},
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
    hooks: AgentHooks,
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
      await hooks.onEvent?.({
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
   * Validate the structured answer without throwing: prefer the `respond` tool's
   * returned object, else parse the output as JSON, then check required keys and
   * run the optional `parse`. Returns the validated object or the failure reason.
   */
  private validateStructured(
    returns: unknown[],
    output: string,
  ): { ok: true; object: unknown } | { ok: false; error: Error } {
    const spec = this.config.responseSchema
    if (!spec) return { ok: true, object: undefined }
    const raw = returns.length > 0 ? returns[returns.length - 1] : safeJsonParse(output)
    try {
      assertSchema(raw, spec.schema)
      return { ok: true, object: spec.parse ? spec.parse(raw) : raw }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  /**
   * Pull the structured answer for a `responseSchema` run, raising
   * `AgentError('response_schema')` on failure.
   */
  private extractStructured(returns: unknown[], output: string): unknown {
    const check = this.validateStructured(returns, output)
    if (check.ok) return check.object
    throw new AgentError('response_schema', check.error.message, { cause: check.error })
  }

  /**
   * Structured-output auto-repair: while the answer fails its schema, feed the
   * validation error back to the model and re-run the reasoning loop, up to
   * `responseSchema.repair` extra attempts. Usage/trace/returns from each attempt
   * are merged so accounting stays whole. No-op unless `repair` is set.
   */
  private async repairStructured(
    result: ReasoningResult,
    input: ReasoningInput,
    hooks: AgentHooks,
  ): Promise<ReasoningResult> {
    const spec = this.config.responseSchema
    const max = spec?.repair ?? 0
    if (!spec || max <= 0) return result

    let attempt = 0
    let current = result
    while (attempt < max) {
      const check = this.validateStructured(current.returns, current.output)
      if (check.ok) return current
      attempt++
      await hooks.onEvent?.({
        type: 'thinking',
        agent: this.name,
        text: `structured response invalid (${check.error.message}); repair attempt ${attempt}/${max}`,
      })
      // The reasoning loop mutates `input.messages` in place; append the fix-up
      // request to that shared transcript, then re-run from where it left off.
      input.messages.push({
        role: 'user',
        content: repairInstruction(spec.name ?? RESPONSE_TOOL_NAME, check.error.message),
      })
      current = mergeReasoning(current, await this.strategy.run(input))
    }
    return current
  }

  /** Apply the optional planner to narrow the toolset for this turn. */
  private async selectTools(
    input: string,
    tools: Tool[],
    history: Message[],
    hooks: AgentHooks,
  ): Promise<Tool[]> {
    if (!this.config.planner) return tools
    const plan = await this.config.planner.plan(input, {
      agentName: this.name,
      history,
      availableTools: tools.map((t) => t.name),
    })
    await hooks.onEvent?.({
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
  private async fitContext(messages: Message[], hooks: AgentHooks): Promise<Message[]> {
    const limit = this.config.contextLimit
    if (!limit) return messages
    const counter: TokenCounter = this.config.tokenCounter ?? approxTokenCounter
    const trimmed = fitContext(messages, { counter, limit })
    const dropped = messages.length - trimmed.length
    if (dropped > 0) {
      const tokens = trimmed.reduce((sum, m) => sum + counter.count(m.content), 0)
      await hooks.onEvent?.({ type: 'context_trimmed', agent: this.name, dropped, tokens })
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

/**
 * Combine two reasoning passes (the original + one repair re-run) into a single
 * result: the latest output, with usage/trace/returns/tools accumulated across
 * both. The transcript is shared (mutated in place), so `next.messages` already
 * holds the full history.
 */
function mergeReasoning(prev: ReasoningResult, next: ReasoningResult): ReasoningResult {
  return {
    output: next.output,
    returns: [...prev.returns, ...next.returns],
    trace: [...prev.trace, ...next.trace],
    messages: next.messages,
    steps: prev.steps + next.steps,
    usage: addUsage(addUsage(emptyUsage(), prev.usage), next.usage),
    toolsInvoked: [...prev.toolsInvoked, ...next.toolsInvoked],
  }
}

/** Sum each step's usage under the model id that produced it (skipping unlabeled steps). */
function aggregateUsageByModel(trace: StepTrace[]): Record<string, Usage> {
  const byModel: Record<string, Usage> = {}
  for (const step of trace) {
    if (!step.model) continue
    byModel[step.model] = addUsage(byModel[step.model] ?? emptyUsage(), step.usage)
  }
  return byModel
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
