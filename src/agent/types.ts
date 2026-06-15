import type { TokenCounter } from '../cognition/context'
import type { LanguageModel } from '../cognition/model'
/**
 * Agent contracts shared between the orchestrator, the prototype base class, and
 * the multi-agent (Layer 2) composition helpers.
 */
import type { Planner } from '../cognition/planner'
import type { ReasoningStrategy, StepTrace } from '../cognition/strategy'
import type { Memory } from '../memory/memory'
import type { InputGuardrail, OutputGuardrail } from '../observability/guardrail'
import type { AgentHooks } from '../observability/hooks'
import type { UsageLimiter } from '../observability/limiter'
import type { ToolProvider } from '../protocol/provider'
import type { Message, RunInput, Usage } from '../shared/types'
import type { Skill } from '../skill/skill'
import type { ToolApprover } from '../tooling/approval'
import type { Tool } from '../tooling/tool'
import type { ResponseSchema } from './response'

/** Options for a single {@link IAgent.run}. */
export interface RunOptions {
  signal?: AbortSignal
  /** Per-run data merged into the {@link ToolContext}. */
  metadata?: Record<string, unknown>
}

/** The outcome of a run. */
export interface RunResult {
  /** Final text answer (directReturn messages are joined for display). */
  output: string
  /**
   * Raw values returned by `directReturn` tools this turn, in call order, with
   * objects preserved — for structured output. Empty unless a directReturn tool
   * fired. The plain-text {@link RunResult.output} is derived from these.
   */
  returns: unknown[]
  /**
   * Per-loop breakdown: token usage, the model's text, and the tools run + their
   * return values for each reasoning loop. The non-streaming counterpart to the
   * `step` / `tool_call` / `tool_result` events.
   */
  trace: StepTrace[]
  messages: Message[]
  steps: number
  usage: Usage
  toolsInvoked: string[]
  /** Names of skills whose tools were invoked this turn (deduped). */
  skillsUsed: string[]
  /**
   * The validated structured answer, present only when {@link AgentConfig.responseSchema}
   * is configured. {@link RunResult.output} holds its JSON rendering.
   */
  object?: unknown
}

/**
 * The agent contract. Anything that can take a string and produce a result is
 * an agent — including a custom orchestration a user writes by extending
 * {@link BaseAgent}.
 */
export interface IAgent {
  readonly name: string
  run(input: RunInput, options?: RunOptions): Promise<RunResult>
}

/** Configuration for the default {@link Agent}. */
export interface AgentConfig {
  /** Identifier used in events and when exposed as a tool. Defaults to `"agent"`. */
  name?: string
  /** Cognition: the model that drives reasoning. */
  model: LanguageModel
  /** Static operating instructions (how to do the job) prepended to every run. */
  instructions?: string
  /** Persona/voice prepended ahead of {@link AgentConfig.instructions}. */
  persona?: string
  /**
   * In-prompt safety/policy constraints (what the agent must never do). Rendered
   * LAST in the system prompt — after persona, instructions, skills, and facts —
   * wrapped in framing that declares it overrides everything above and any user
   * request. This *asks* the model to comply; for *enforced* checks use
   * {@link AgentConfig.inputGuardrails} / {@link AgentConfig.outputGuardrails}.
   */
  policy?: string
  /** Tooling: locally-registered tools. */
  tools?: Tool[]
  /**
   * Tooling (Skills): named bundles of tools + instruction fragments. Each
   * skill's tools are exposed and its instruction is injected into the system
   * prompt. See {@link Skill}.
   */
  skills?: Skill[]
  /** Protocol: external tool sources resolved at run time (e.g. MCP). */
  toolProviders?: ToolProvider[]
  /**
   * Human-in-the-loop gate consulted before any tool flagged `requiresApproval`
   * runs. It can allow, deny, or edit the call's arguments. With a guarded tool
   * but no approver, the call is denied by default. See {@link ToolApprover}.
   */
  toolApprover?: ToolApprover
  /** Cognition: optional routing/intent planner. */
  planner?: Planner
  /** Cognition: reasoning algorithm. Defaults to {@link ReActStrategy}. */
  strategy?: ReasoningStrategy
  /**
   * Structured output: when set, the agent exposes a synthetic `respond` tool whose
   * parameters are this schema, instructs the model to answer through it, and exposes
   * the validated object on {@link RunResult.object} (its JSON on `output`).
   */
  responseSchema?: ResponseSchema
  /**
   * Stream `directReturn` tool results as `output` events (`final: false`) and
   * keep looping, instead of letting the first directReturn end the turn. The
   * final answer is emitted as an `output` event with `final: true`. Lets one
   * turn surface several results (e.g. multiple cards). Defaults to false.
   */
  streamDirectReturns?: boolean
  /** Memory backend. Defaults to a fresh {@link InMemoryMemory}. */
  memory?: Memory
  /**
   * When true, auto-register a `remember_fact` tool so the model can write to
   * long-term memory itself. Requires a memory backend with `rememberFact`.
   * Defaults to false.
   */
  rememberFacts?: boolean
  /**
   * Max number of long-term facts injected into the system prompt per turn.
   * When the memory backend supports `searchFacts`, the most relevant facts to
   * the current input are chosen. Defaults to 8.
   */
  factRecallLimit?: number
  /** Application + Governance: event hooks. */
  hooks?: AgentHooks
  /**
   * Governance: a usage ceiling consulted before each run (it can block with an
   * `AgentError` tagged `"rate_limit"`) and notified of token usage after. Use to
   * enforce per-user run/token budgets. See {@link UsageLimiter}. Defaults to none.
   */
  usageLimiter?: UsageLimiter
  /**
   * Governance: input guardrails run in order BEFORE the model. The first to block
   * short-circuits the turn — the model is never called and the verdict's output
   * (or a default refusal) is returned. Use to stop prompt injection / disallowed
   * input early. Defaults to none.
   */
  inputGuardrails?: InputGuardrail[]
  /**
   * Governance: output guardrails run in order after the answer is produced. The
   * first to block replaces the answer (and drops structured `returns`) and emits
   * a `guardrail` event. The in-prompt {@link AgentConfig.policy} asks the
   * model to behave; these enforce it. Defaults to none.
   */
  outputGuardrails?: OutputGuardrail[]
  /** Hard cap on reasoning loop iterations. Defaults to 10. */
  maxSteps?: number
  /**
   * Trim the transcript to at most this many tokens before each model turn (system
   * messages and the latest message are always kept; oldest middle turns drop
   * first). Emits a `context_trimmed` event when it drops anything. Requires/uses
   * {@link AgentConfig.tokenCounter}. Defaults to no limit.
   */
  contextLimit?: number
  /**
   * Token counter used for {@link AgentConfig.contextLimit}. Defaults to a
   * dependency-free ~4-chars/token heuristic; plug a real provider tokenizer for
   * precision.
   */
  tokenCounter?: TokenCounter
  /**
   * Abort the whole run after this many milliseconds (combined with any
   * `RunOptions.signal`). On timeout the run rejects with an `AgentError` whose
   * stage is `"timeout"`. Effective only insofar as the model/tools honor the
   * abort signal. Defaults to no timeout.
   */
  timeoutMs?: number
}
