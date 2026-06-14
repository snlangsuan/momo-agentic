import type { LanguageModel } from '../cognition/model'
/**
 * Agent contracts shared between the orchestrator, the prototype base class, and
 * the multi-agent (Layer 2) composition helpers.
 */
import type { Planner } from '../cognition/planner'
import type { ReasoningStrategy } from '../cognition/strategy'
import type { Memory } from '../memory/memory'
import type { AgentHooks } from '../observability/hooks'
import type { ToolProvider } from '../protocol/provider'
import type { Message, Usage } from '../shared/types'
import type { Skill } from '../skill/skill'
import type { Tool } from '../tooling/tool'

/** Options for a single {@link IAgent.run}. */
export interface RunOptions {
  signal?: AbortSignal
  /** Per-run data merged into the {@link ToolContext}. */
  metadata?: Record<string, unknown>
}

/** The outcome of a run. */
export interface RunResult {
  output: string
  messages: Message[]
  steps: number
  usage: Usage
  toolsInvoked: string[]
  /** Names of skills whose tools were invoked this turn (deduped). */
  skillsUsed: string[]
}

/**
 * The agent contract. Anything that can take a string and produce a result is
 * an agent — including a custom orchestration a user writes by extending
 * {@link BaseAgent}.
 */
export interface IAgent {
  readonly name: string
  run(input: string, options?: RunOptions): Promise<RunResult>
}

/** Configuration for the default {@link Agent}. */
export interface AgentConfig {
  /** Identifier used in events and when exposed as a tool. Defaults to `"agent"`. */
  name?: string
  /** Cognition: the model that drives reasoning. */
  model: LanguageModel
  /** Static system rules/constraints prepended to every run. */
  instructions?: string
  /** Persona/voice prepended ahead of {@link AgentConfig.instructions}. */
  persona?: string
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
  /** Cognition: optional routing/intent planner. */
  planner?: Planner
  /** Cognition: reasoning algorithm. Defaults to {@link ReActStrategy}. */
  strategy?: ReasoningStrategy
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
  /** Hard cap on reasoning loop iterations. Defaults to 10. */
  maxSteps?: number
}
