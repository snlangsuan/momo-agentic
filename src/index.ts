/**
 * momo-agentic — a layered TypeScript library for building agentic bots.
 *
 * The public API is organized along the 8 architectural layers of agentic AI.
 * Infrastructure (Layer 1) is intentionally absent: it is injected by the host
 * application through the ports below, never baked into the library.
 *
 * @packageDocumentation
 */

// Shared primitives
export type { Message, Role, ToolCall, ToolSchema, Usage } from './shared/types'
export { addUsage, emptyUsage } from './shared/types'

// Layer 4 — Tooling
export { BaseTool, defineTool, toToolSchema, ToolRegistry } from './tooling'
export type { Tool, ToolContext, ToolDefinition } from './tooling'

// Layer 4 — Tooling (Skills)
export {
  BaseSkill,
  defineSkill,
  defineSkillFromManifest,
  parseSkillManifest,
  SkillRegistry,
} from './skill'
export type { Skill, SkillDefinition, SkillManifest } from './skill'

// Layer 5 — Cognition
export { ReActStrategy } from './cognition'
export type {
  GenerateOptions,
  LanguageModel,
  ModelResponse,
  Plan,
  PlanContext,
  Planner,
  ReasoningInput,
  ReasoningResult,
  ReasoningStrategy,
} from './cognition'

// Layer 6 — Memory
export { createRememberTool, InMemoryMemory, SummarizingMemory } from './memory'
export type {
  ConversationMemory,
  FactMemory,
  LoadHistoryOptions,
  Memory,
  MemoryFact,
  RememberToolOptions,
  Summarizer,
  SummarizingMemoryOptions,
} from './memory'

// Layer 3 — Protocol
export { collectProviderTools, defineToolProvider } from './protocol'
export type { ToolProvider } from './protocol'

// Layer 7 (Application) + Layer 8 (Governance) — Observability hooks
export { combineHooks, UsageTracker } from './observability'
export type { AgentEvent, AgentHooks, UsageSnapshot } from './observability'

// Agent orchestrator + Layer 2 (Agent Internet)
export { Agent, AgentError, BaseAgent } from './agent'
export type { AgentConfig, IAgent, RunOptions, RunResult } from './agent'
export { agentAsTool } from './network'
export type { AgentAsToolOptions } from './network'
