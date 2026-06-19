import type { LanguageModel } from '@/cognition/model'
import { runModel } from '@/cognition/run-model'
import type { AgentHooks } from '@/observability/hooks'
/**
 * Layer 5 — Cognition (reasoning core).
 *
 * A ReasoningStrategy owns the decision loop: model ⇄ tools ⇄ model until a
 * final answer. Extracting it from the Agent keeps the agent a thin orchestrator
 * (Single Responsibility) and lets users swap the reasoning algorithm (ReAct,
 * plan-and-execute, reflexion, ...) without touching memory/hooks/persistence.
 */
import { type Message, type ToolCall, type Usage, addUsage, emptyUsage } from '@/shared/types'
import type { ToolApprover } from '@/tooling/approval'
import { type Tool, type ToolContext, toToolSchema } from '@/tooling/tool'
import { validateArguments } from '@/tooling/validate'

/** Everything a strategy needs to run one turn. */
export interface ReasoningInput {
  agentName: string
  model: LanguageModel
  tools: Tool[]
  /** Working transcript; the strategy appends assistant/tool messages to it. */
  messages: Message[]
  maxSteps: number
  toolContext: ToolContext
  hooks?: AgentHooks
  signal?: AbortSignal
  /** Optional human-in-the-loop gate consulted before any `requiresApproval` tool runs. */
  approver?: ToolApprover
  /**
   * When true, a `directReturn` tool does NOT short-circuit the turn. Instead its
   * value is streamed as an `output` event (`final: false`) and the loop
   * continues, so one turn can emit several results before the final answer
   * (`output` with `final: true`). Defaults to false (directReturn is terminal).
   */
  streamDirectReturns?: boolean
  /**
   * Seed accumulators from a prior checkpoint to RESUME a durable run: the loop
   * continues from `step` with the carried `usage` / `toolsInvoked`, while
   * `messages` is the restored transcript. See {@link ReasoningInput.onStep}.
   */
  resume?: { step: number; usage: Usage; toolsInvoked: string[] }
  /**
   * Called after each completed tool step with a snapshot of the run, for durable
   * checkpointing. The snapshot is freshly copied, so the callback may persist it
   * directly. Not called on the step that produces the final answer (the run is
   * finishing). See {@link ReasoningInput.resume}.
   */
  onStep?: (snapshot: {
    messages: Message[]
    step: number
    usage: Usage
    toolsInvoked: string[]
  }) => void | Promise<void>
}

/** One tool execution within a reasoning loop. */
export interface ToolTrace {
  name: string
  args: Record<string, unknown>
  /** The tool's raw return value (objects preserved). */
  result: unknown
}

/** A per-loop record: tokens, the model's text, and the tools it ran. */
export interface StepTrace {
  step: number
  /**
   * Id of the model that produced this step's call. Lets a trace be attributed
   * per model when a turn mixes them (e.g. a separate planning model).
   */
  model?: string
  /** Token usage for this loop's model call. */
  usage: Usage
  /** Assistant text produced this loop (reasoning, or the final answer). */
  text?: string
  /** Tools executed this loop, in call order. */
  tools: ToolTrace[]
}

/** Result of a completed reasoning turn. */
export interface ReasoningResult {
  /** Final text answer (directReturn messages are joined for display). */
  output: string
  /**
   * Raw values returned by `directReturn` tools this turn, in call order, with
   * objects preserved. Use this when a tool returns structured data (a card,
   * JSON, ...) instead of plain text. Empty unless a directReturn tool fired.
   */
  returns: unknown[]
  /**
   * Per-loop breakdown (one entry per model call) with token usage, the model's
   * text, and the tools run + their return values. The same data the `step` /
   * `tool_call` / `tool_result` events stream, collected for consumers that
   * prefer the final result over hooks.
   */
  trace: StepTrace[]
  messages: Message[]
  steps: number
  usage: Usage
  /** Names of tools invoked this turn, in call order (with repeats). */
  toolsInvoked: string[]
}

/** Pluggable reasoning algorithm port. */
export interface ReasoningStrategy {
  readonly name: string
  run(input: ReasoningInput): Promise<ReasoningResult>
}

/** Internal: the resolved approval for one tool call (denied, or allowed args). */
type ApprovalOutcome =
  | { denied: true; reason?: string }
  | { denied: false; args: Record<string, unknown> }

/** Serialize args deterministically for the loop-guard signature. */
function callSignature(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = args[k]
      return acc
    }, {})
  return `${name}:${JSON.stringify(sorted)}`
}

function stringifyResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result)
}

/** Pull a user-facing string out of a `directReturn` tool result. */
function extractDirectMessage(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'message' in result) {
    const msg = (result as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
  }
  return stringifyResult(result)
}

/**
 * The classic ReAct loop: reason → act (tool calls) → observe → repeat, bounded
 * by `maxSteps`. Within a step, all tool calls run CONCURRENTLY, with results
 * recorded in the original call order. A `directReturn` tool short-circuits the
 * turn: with several directReturn tools their messages are joined in call order,
 * and a mix of directReturn + normal tools still returns the directReturn answer.
 * With `streamDirectReturns`, directReturn results are instead emitted as partial
 * `output` events and the loop continues until the model's final answer.
 *
 * Includes error handling the cognition layer is responsible for: a hard step
 * cap, an immediate-repeat tool guard (anti-tight-loop), and per-tool error
 * capture so one failing tool never aborts the turn.
 */
export class ReActStrategy implements ReasoningStrategy {
  readonly name = 'react'

  async run(input: ReasoningInput): Promise<ReasoningResult> {
    const { model, tools, messages, maxSteps, toolContext, hooks, signal, agentName } = input
    const approver = input.approver
    const stream = input.streamDirectReturns === true
    const schemas = tools.map(toToolSchema)
    const byName = new Map(tools.map((t) => [t.name, t]))
    const usage = input.resume ? addUsage(emptyUsage(), input.resume.usage) : emptyUsage()
    const toolsInvoked: string[] = input.resume ? [...input.resume.toolsInvoked] : []
    const allReturns: unknown[] = []
    const trace: StepTrace[] = []
    let lastStepSignatures = new Set<string>()
    let steps = input.resume?.step ?? 0

    while (steps < maxSteps) {
      steps++
      const response = await runModel(model, { messages, tools: schemas, signal }, hooks, agentName)
      addUsage(usage, response.usage)

      // Per-loop token usage (this model call only).
      const stepEntry: StepTrace = {
        step: steps,
        model: model.id,
        usage: addUsage(emptyUsage(), response.usage),
        tools: [],
      }
      if (response.content) stepEntry.text = response.content
      trace.push(stepEntry)
      await hooks?.onEvent?.({
        type: 'step',
        agent: agentName,
        step: steps,
        model: model.id,
        usage: stepEntry.usage,
      })

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })

      if (response.content) {
        await hooks?.onEvent?.({ type: 'thinking', agent: agentName, text: response.content })
      }

      const toolCalls = response.toolCalls ?? []
      if (toolCalls.length === 0) {
        await this.emitFinal(hooks, agentName, response.content)
        return {
          output: response.content,
          returns: allReturns,
          trace,
          messages,
          steps,
          usage,
          toolsInvoked,
        }
      }

      const step = await this.runStep({
        toolCalls,
        byName,
        messages,
        toolContext,
        hooks,
        agentName,
        lastStepSignatures,
        toolsInvoked,
        stream,
        stepIndex: steps,
        approver,
      })
      stepEntry.tools = step.toolTraces
      allReturns.push(...step.directValues)

      // Default mode: a directReturn tool short-circuits with its message as the
      // final answer. Stream mode: directReturn was already emitted, keep looping.
      if (!stream && step.directOutput !== null) {
        await this.emitFinal(hooks, agentName, step.directOutput)
        return {
          output: step.directOutput,
          returns: step.directValues,
          trace,
          messages,
          steps,
          usage,
          toolsInvoked,
        }
      }
      lastStepSignatures = step.signatures

      // Checkpoint the just-completed step (transcript now includes its tool
      // results) so a crash before the next model call can resume from here.
      await input.onStep?.({
        messages: [...messages],
        step: steps,
        usage: addUsage(emptyUsage(), usage),
        toolsInvoked: [...toolsInvoked],
      })
    }

    // Hit the step cap: surface the last assistant text we have.
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)
    const output = last?.content ?? ''
    await this.emitFinal(hooks, agentName, output)
    return { output, returns: allReturns, trace, messages, steps, usage, toolsInvoked }
  }

  /** Emit the turn's final answer as an `output` event (`final: true`). */
  private async emitFinal(
    hooks: AgentHooks | undefined,
    agent: string,
    value: unknown,
  ): Promise<void> {
    await hooks?.onEvent?.({ type: 'output', agent, value, final: true })
  }

  /**
   * Execute one step's tool calls CONCURRENTLY, recording results in call order.
   * `executeOne` registers its dedup signature synchronously (before its first
   * await), so parallel duplicates are still blocked with the earlier call
   * winning. Returns the joined directReturn messages (or null to keep looping).
   */
  private async runStep(args: {
    toolCalls: ToolCall[]
    byName: Map<string, Tool>
    messages: Message[]
    toolContext: ToolContext
    hooks?: AgentHooks
    agentName: string
    lastStepSignatures: Set<string>
    toolsInvoked: string[]
    stream: boolean
    stepIndex: number
    approver?: ToolApprover
  }): Promise<{
    directOutput: string | null
    directValues: unknown[]
    toolTraces: ToolTrace[]
    signatures: Set<string>
  }> {
    const {
      toolCalls,
      byName,
      messages,
      toolContext,
      hooks,
      agentName,
      lastStepSignatures,
      toolsInvoked,
      stream,
      stepIndex,
      approver,
    } = args

    // Announce every call (in order), then resolve approval for guarded tools —
    // both sequential so events stay ordered before the concurrent execution.
    const approvals = new Map<ToolCall, ApprovalOutcome>()
    for (const call of toolCalls) {
      toolsInvoked.push(call.name)
      await hooks?.onEvent?.({
        type: 'tool_call',
        agent: agentName,
        step: stepIndex,
        tool: call.name,
        args: call.arguments,
      })
      if (byName.get(call.name)?.requiresApproval) {
        approvals.set(
          call,
          await this.resolveApproval(call, approver, toolContext, hooks, stepIndex),
        )
      }
    }

    const signatures = new Set<string>()
    const results = await Promise.all(
      toolCalls.map((call) =>
        this.executeOne(
          call,
          byName.get(call.name),
          toolContext,
          signatures,
          lastStepSignatures,
          approvals.get(call),
        ),
      ),
    )

    // Record results in call order; collect directReturn messages + raw values.
    const directOutputs: string[] = []
    const directValues: unknown[] = []
    const toolTraces: ToolTrace[] = []
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const result = results[i]
      if (!call || !result) continue
      toolTraces.push({ name: call.name, args: call.arguments, result: result.value })
      await hooks?.onEvent?.({
        type: 'tool_result',
        agent: agentName,
        step: stepIndex,
        tool: call.name,
        result: result.value,
      })
      messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: result.text })
      if (byName.get(call.name)?.directReturn) {
        directOutputs.push(extractDirectMessage(result.value))
        directValues.push(result.value)
        // Stream mode: surface each directReturn result immediately (partial).
        if (stream) {
          await hooks?.onEvent?.({
            type: 'output',
            agent: agentName,
            value: result.value,
            final: false,
          })
        }
      }
    }

    // Multiple directReturn messages are joined in call order ("answer in
    // sequence"); a mix of directReturn + normal tools still returns the
    // directReturn answer. The raw values are returned alongside for consumers
    // that need structured (object) output.
    return {
      directOutput: directOutputs.length > 0 ? directOutputs.join('\n\n') : null,
      directValues,
      toolTraces,
      signatures,
    }
  }

  /**
   * Consult the approver for a guarded tool call and emit a `tool_approval` event.
   * With no approver configured, a guarded call is denied (safe by default).
   */
  private async resolveApproval(
    call: ToolCall,
    approver: ToolApprover | undefined,
    toolContext: ToolContext,
    hooks: AgentHooks | undefined,
    stepIndex: number,
  ): Promise<ApprovalOutcome> {
    const emit = (decision: 'allow' | 'deny' | 'edit', reason?: string) =>
      hooks?.onEvent?.({
        type: 'tool_approval',
        agent: toolContext.agentName,
        step: stepIndex,
        tool: call.name,
        decision,
        reason,
      })

    if (!approver) {
      await emit('deny', 'no approver configured')
      return { denied: true, reason: 'no approver configured' }
    }
    const decision = await approver.approve({
      agentName: toolContext.agentName,
      tool: call.name,
      args: call.arguments,
      metadata: toolContext.metadata,
      signal: toolContext.signal,
    })
    if (decision.decision === 'deny') {
      await emit('deny', decision.reason)
      return { denied: true, reason: decision.reason }
    }
    if (decision.decision === 'edit') {
      await emit('edit')
      return { denied: false, args: decision.args }
    }
    await emit('allow')
    return { denied: false, args: call.arguments }
  }

  private async executeOne(
    call: { name: string; arguments: Record<string, unknown> },
    tool: Tool | undefined,
    toolContext: ToolContext,
    currentSignatures: Set<string>,
    lastStepSignatures: Set<string>,
    approval?: ApprovalOutcome,
  ): Promise<{ value: unknown; text: string }> {
    if (!tool) {
      const value = { error: `Unknown tool "${call.name}"` }
      return { value, text: stringifyResult(value) }
    }

    if (approval?.denied) {
      const reason = approval.reason ? `: ${approval.reason}` : ''
      const value = { error: `Tool "${call.name}" call was not approved${reason}.` }
      return { value, text: stringifyResult(value) }
    }
    // Run with the (possibly edited) approved arguments.
    const args = approval && !approval.denied ? approval.args : call.arguments

    const signature = callSignature(call.name, args)
    // Anti-tight-loop: refuse an identical call repeated from the previous step,
    // or duplicated earlier in this step. The signature is recorded EVEN when
    // blocked, so it carries into the next step's `lastStepSignatures`: a call the
    // model keeps re-issuing every step stays blocked, instead of oscillating
    // executed/blocked/executed. A genuine re-call is still allowed once any other
    // call breaks the streak, or when the arguments differ.
    if (lastStepSignatures.has(signature) || currentSignatures.has(signature)) {
      currentSignatures.add(signature)
      const value = {
        error: `Tool "${call.name}" was already called with identical arguments; repeat blocked to avoid loops.`,
      }
      return { value, text: stringifyResult(value) }
    }
    currentSignatures.add(signature)

    // Validate arguments before running: a failure becomes an error the model
    // can correct, not a crashed or silently-wrong call.
    const validated = validateToolArgs(tool, args)
    if (!validated.ok) {
      const value = { error: `Invalid arguments for "${call.name}": ${validated.message}` }
      return { value, text: stringifyResult(value) }
    }

    try {
      const value = await runWithTimeout(tool, validated.args, toolContext)
      return { value, text: stringifyResult(value) }
    } catch (error) {
      const value = { error: error instanceof Error ? error.message : String(error) }
      return { value, text: stringifyResult(value) }
    }
  }
}

/**
 * Run the built-in required/type check, then the tool's optional `parse`.
 * Returns the (possibly coerced) arguments, or a message describing the problem.
 */
function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const error = validateArguments(tool.parameters, args)
    if (error) return { ok: false, message: error }
    return { ok: true, args: tool.parse ? tool.parse(args) : args }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run a tool, enforcing its `timeoutMs` if set. A fresh AbortController is
 * chained to the run signal and passed to `execute`, so a cooperative tool can
 * cancel; the timer rejects with a clear message either way.
 */
function runWithTimeout(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  if (tool.timeoutMs === undefined) return Promise.resolve(tool.execute(args, context))

  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  context.signal?.addEventListener('abort', onParentAbort)
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Tool "${tool.name}" timed out after ${tool.timeoutMs}ms`))
    }, tool.timeoutMs)
  })

  const run = Promise.resolve(tool.execute(args, { ...context, signal: controller.signal }))
  return Promise.race([run, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
    context.signal?.removeEventListener('abort', onParentAbort)
  })
}
