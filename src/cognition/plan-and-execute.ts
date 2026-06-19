import type { LanguageModel } from '@/cognition/model'
import { runModel } from '@/cognition/run-model'
import { ReActStrategy } from '@/cognition/strategy'
import type {
  ReasoningInput,
  ReasoningResult,
  ReasoningStrategy,
  StepTrace,
} from '@/cognition/strategy'
/**
 * Layer 5 — Cognition (reasoning core, plan-and-execute).
 *
 * An alternative {@link ReasoningStrategy} to {@link ReActStrategy}. Where ReAct
 * interleaves a single reason→act loop, plan-and-execute splits the turn into
 * three phases:
 *
 *  1. **Plan** — one model call breaks the request into an ordered list of
 *     concrete steps (via a synthetic `create_plan` tool, with a text fallback).
 *  2. **Execute** — each step runs through an inner strategy (a `ReActStrategy`
 *     by default) so a single step may itself call several tools.
 *  3. **Synthesize** — a final model call composes the user-facing answer from
 *     every step's result.
 *
 * It is a drop-in `strategy` for the `Agent` and returns the same
 * {@link ReasoningResult} shape (usage, trace, returns, toolsInvoked are all
 * accumulated across phases), so memory, hooks, and persistence are unaffected.
 */
import type { AgentHooks } from '@/observability/hooks'
import { type Message, type ToolSchema, type Usage, addUsage, emptyUsage } from '@/shared/types'

/** Mutable accumulators threaded through a single {@link PlanAndExecuteStrategy} run. */
interface RunAccumulators {
  usage: Usage
  trace: StepTrace[]
  toolsInvoked: string[]
  returns: unknown[]
}

/** Tuning for {@link PlanAndExecuteStrategy}. */
export interface PlanAndExecuteOptions {
  /**
   * Strategy used to execute each individual plan step. Defaults to a fresh
   * {@link ReActStrategy}, so each step gets its own bounded reason→act loop.
   */
  executor?: ReasoningStrategy
  /**
   * Model used for the planning calls — building the initial plan and any
   * re-planning. When omitted, the run's main model (the `Agent`'s `model`) is
   * used for everything. Set this to assign a cheaper/faster model to planning
   * while the heavier step execution and final synthesis keep using the main
   * model, e.g. `new PlanAndExecuteStrategy({ planningModel: cheapModel })`.
   */
  planningModel?: LanguageModel
  /**
   * Max reasoning-loop iterations the inner executor may take to complete ONE plan
   * step (passed as the executor's `maxSteps`). Defaults to the run's `maxSteps`.
   * Total model calls are roughly `1 (plan) + planSteps×executorMaxSteps + 1 (synth)`.
   */
  executorMaxSteps?: number
  /**
   * Hard cap on the number of plan steps executed; extra steps are dropped (and
   * reported via a `plan` hook event). Also bounds steps added by re-planning.
   * Defaults to 10.
   */
  maxPlanSteps?: number
  /**
   * Re-plan the *remaining* steps after each step, based on the results so far,
   * so the plan adapts to what actually happened (a tool failed, returned
   * surprising data, ...). Off by default — when off the initial plan is fixed.
   */
  replan?: boolean
  /**
   * Max number of re-plan *attempts* (one model call each, whether or not they
   * change the plan) when {@link PlanAndExecuteOptions.replan} is on. Bounds
   * adaptation cost. Defaults to 3.
   */
  maxReplans?: number
}

/** JSON Schema for a `{ steps: string[] }` plan argument. */
const STEPS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ordered steps, each a single concrete instruction.',
    },
  },
  required: ['steps'],
}

/** Synthetic tool the model calls to emit a structured plan. Never executed. */
const PLAN_TOOL: ToolSchema = {
  name: 'create_plan',
  description:
    'Break the user request into an ordered list of concrete, actionable steps to execute in sequence.',
  parameters: STEPS_PARAMETERS,
}

/** Synthetic tool the model calls to revise the remaining steps. Never executed. */
const REVISE_TOOL: ToolSchema = {
  name: 'revise_plan',
  description:
    'Revise the remaining steps based on the results so far. Pass the full new list of remaining steps, or an empty list to finish now.',
  parameters: STEPS_PARAMETERS,
}

/** Strip a leading list marker (`1.`, `-`, `*`, `1)`) from a plan line. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()
}

/** Parse a numbered/bulleted plan out of free-form model text (the fallback). */
function parsePlanText(text: string): string[] {
  return text
    .split('\n')
    .map(stripMarker)
    .filter((line) => line.length > 0)
}

/**
 * Plan-and-execute reasoning: plan the whole turn up front, execute each step
 * with an inner strategy, then synthesize a final answer. Swap it in via
 * `new Agent({ model, strategy: new PlanAndExecuteStrategy() })`.
 *
 * Notes:
 * - If the planning call neither calls `create_plan` nor yields a parseable list,
 *   the turn degrades gracefully to a single step over the original request.
 * - A `directReturn` tool fired inside a step is collected into `returns` and
 *   execution continues; the synthesized answer remains the turn's `output`.
 * - With `replan` on, the remaining steps are revised after each step from the
 *   results so far (a new `plan` event is emitted on each revision), so the plan
 *   adapts to what actually happened.
 * - Set `planningModel` to run planning/re-planning on a separate (e.g. cheaper)
 *   model while step execution and synthesis keep using the main model.
 */
export class PlanAndExecuteStrategy implements ReasoningStrategy {
  readonly name = 'plan-and-execute'
  private readonly executor: ReasoningStrategy
  private readonly executorMaxSteps?: number
  private readonly maxPlanSteps: number
  private readonly replan: boolean
  private readonly maxReplans: number
  private readonly planningModel?: LanguageModel

  constructor(options: PlanAndExecuteOptions = {}) {
    this.executor = options.executor ?? new ReActStrategy()
    this.executorMaxSteps = options.executorMaxSteps
    this.maxPlanSteps = options.maxPlanSteps ?? 10
    this.replan = options.replan ?? false
    this.maxReplans = options.maxReplans ?? 3
    this.planningModel = options.planningModel
  }

  async run(input: ReasoningInput): Promise<ReasoningResult> {
    const { model, messages, hooks, signal, agentName } = input
    const acc: RunAccumulators = {
      usage: emptyUsage(),
      trace: [],
      toolsInvoked: [],
      returns: [],
    }
    // Record a single model call (planning / re-planning / synthesis) as one trace
    // entry + a `step` event. Step numbers are made sequential at the end.
    const record = async (entry: Omit<StepTrace, 'step'>): Promise<void> => {
      acc.trace.push({ ...entry, step: 0 })
      addUsage(acc.usage, entry.usage)
      await hooks?.onEvent?.({
        type: 'step',
        agent: agentName,
        step: acc.trace.length,
        model: entry.model,
        usage: entry.usage,
      })
    }

    // --- Phase 1: plan ------------------------------------------------------
    // Planning (and re-planning) may run on a cheaper model; execution and
    // synthesis stay on the run's main model.
    const planningModel = this.planningModel ?? model
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const planResponse = await runModel(
      planningModel,
      {
        messages: [...messages, { role: 'user', content: planningInstruction(lastUser) }],
        tools: [PLAN_TOOL],
        signal,
      },
      hooks,
      agentName,
    )
    await record({
      model: planningModel.id,
      usage: addUsage(emptyUsage(), planResponse.usage),
      text: planResponse.content,
      tools: [],
    })

    let steps = extractPlanSteps(planResponse)
    if (steps.length === 0) steps = lastUser ? [lastUser] : []
    const truncated = steps.length > this.maxPlanSteps
    if (truncated) steps = steps.slice(0, this.maxPlanSteps)

    const emitPlan = (currentSteps: string[], revised: boolean): Promise<void> =>
      this.emitPlan(input, currentSteps, { revised, capped: truncated && !revised })
    await emitPlan(steps, false)

    // --- Phase 2: execute each step (re-planning the remainder if enabled) --
    await this.executePlan(input, steps, acc, record, emitPlan, planningModel)

    // --- Phase 3: synthesize the final answer ------------------------------
    messages.push({ role: 'user', content: SYNTHESIS_INSTRUCTION })
    const finalResponse = await runModel(model, { messages, tools: [], signal }, hooks, agentName)
    await record({
      model: model.id,
      usage: addUsage(emptyUsage(), finalResponse.usage),
      text: finalResponse.content,
      tools: [],
    })
    messages.push({ role: 'assistant', content: finalResponse.content })

    acc.trace.forEach((t, idx) => {
      t.step = idx + 1
    })
    await emitFinal(hooks, agentName, finalResponse.content)
    return {
      output: finalResponse.content,
      returns: acc.returns,
      trace: acc.trace,
      messages,
      steps: acc.trace.length,
      usage: acc.usage,
      toolsInvoked: acc.toolsInvoked,
    }
  }

  /** Execute each step via the inner strategy, re-planning the remainder if enabled. */
  private async executePlan(
    input: ReasoningInput,
    initialSteps: string[],
    acc: RunAccumulators,
    record: (entry: Omit<StepTrace, 'step'>) => Promise<void>,
    emitPlan: (steps: string[], revised: boolean) => Promise<void>,
    planningModel: LanguageModel,
  ): Promise<void> {
    const { model, messages, signal } = input
    const perStepCap = this.executorMaxSteps ?? input.maxSteps
    let steps = initialSteps
    let executedCount = 0
    let replans = 0
    let i = 0
    while (i < steps.length && executedCount < this.maxPlanSteps) {
      messages.push({ role: 'user', content: stepInstruction(steps, i) })
      const sub = await this.executor.run({
        agentName: input.agentName,
        model,
        tools: input.tools,
        messages, // mutated in place; the sub-run appends to the shared transcript
        maxSteps: perStepCap,
        toolContext: input.toolContext,
        hooks: input.hooks,
        signal,
        approver: input.approver,
        streamDirectReturns: input.streamDirectReturns,
      })
      addUsage(acc.usage, sub.usage)
      acc.toolsInvoked.push(...sub.toolsInvoked)
      acc.returns.push(...sub.returns)
      acc.trace.push(...sub.trace)
      executedCount++
      i++

      if (this.replan && replans < this.maxReplans && executedCount < this.maxPlanSteps) {
        replans++ // count the attempt (a model call), accepted or not, to bound cost
        const revised = await this.revisePlan({
          model: planningModel,
          messages,
          signal,
          record,
          hooks: input.hooks,
          agentName: input.agentName,
        })
        if (revised) {
          steps = [...steps.slice(0, i), ...revised.slice(0, this.maxPlanSteps - executedCount)]
          await emitPlan(steps, true)
        }
      }
    }
  }

  /** Emit a `plan` event for the current plan and mirror it into the transcript. */
  private async emitPlan(
    input: ReasoningInput,
    steps: string[],
    flags: { revised: boolean; capped: boolean },
  ): Promise<void> {
    const planText = steps.map((s, idx) => `${idx + 1}. ${s}`).join('\n')
    const notes: string[] = []
    if (flags.revised) notes.push('revised')
    if (flags.capped) notes.push(`+${this.maxPlanSteps} step cap; extra steps dropped`)
    await input.hooks?.onEvent?.({
      type: 'plan',
      agent: input.agentName,
      mode: this.name,
      reason: notes.length > 0 ? `${planText}\n(${notes.join('; ')})` : planText,
    })
    // Keep the plan in the transcript as plain text (no dangling tool call).
    const label = flags.revised ? 'Revised plan' : 'Plan'
    input.messages.push({ role: 'assistant', content: `${label}:\n${planText}` })
  }

  /**
   * Ask the model whether to revise the remaining steps given the results so far.
   * Returns the new remaining steps (an empty array means "finish now"), or `null`
   * when the model declines to revise (no `revise_plan` call) — leave the plan as is.
   */
  private async revisePlan(args: {
    model: LanguageModel
    messages: Message[]
    signal?: AbortSignal
    record: (entry: Omit<StepTrace, 'step'>) => Promise<void>
    hooks?: AgentHooks
    agentName: string
  }): Promise<string[] | null> {
    const { model, messages, signal, record, hooks, agentName } = args
    const response = await runModel(
      model,
      {
        messages: [...messages, { role: 'user', content: REPLAN_INSTRUCTION }],
        tools: [REVISE_TOOL],
        signal,
      },
      hooks,
      agentName,
    )
    await record({
      model: model.id,
      usage: addUsage(emptyUsage(), response.usage),
      text: response.content,
      tools: [],
    })

    const call = response.toolCalls?.find((c) => c.name === REVISE_TOOL.name)
    const raw = call?.arguments?.steps
    if (!Array.isArray(raw)) return null
    return raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
  }
}

/** Read plan steps from a `create_plan` tool call, falling back to text. */
function extractPlanSteps(response: {
  content: string
  toolCalls?: { name: string; arguments: Record<string, unknown> }[]
}): string[] {
  const call = response.toolCalls?.find((c) => c.name === PLAN_TOOL.name)
  const raw = call?.arguments?.steps
  if (Array.isArray(raw)) {
    const steps = raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
    if (steps.length > 0) return steps
  }
  return parsePlanText(response.content)
}

function planningInstruction(request: string): string {
  return [
    'Before doing anything, plan how to fulfil the request below.',
    'Call the `create_plan` tool with an ordered list of concrete steps.',
    'Keep the plan minimal — only the steps actually needed.',
    '',
    `Request: ${request}`,
  ].join('\n')
}

function stepInstruction(steps: string[], i: number): string {
  return [
    `Execute step ${i + 1} of ${steps.length}: ${steps[i]}`,
    'Use the available tools as needed, then report the result of this step concisely.',
  ].join('\n')
}

const REPLAN_INSTRUCTION = [
  'Review the results so far against the remaining plan.',
  'If the remaining steps need changing (something failed, new info appeared, a step is now unnecessary),',
  'call `revise_plan` with the full new list of remaining steps (empty to finish now).',
  'If the remaining plan is still correct, reply briefly without calling the tool.',
].join('\n')

const SYNTHESIS_INSTRUCTION =
  'All plan steps are complete. Using the step results above, write the final answer for the user. Do not call any tools.'

/** Emit the turn's final answer as an `output` event (`final: true`). */
async function emitFinal(
  hooks: AgentHooks | undefined,
  agent: string,
  value: unknown,
): Promise<void> {
  await hooks?.onEvent?.({ type: 'output', agent, value, final: true })
}
