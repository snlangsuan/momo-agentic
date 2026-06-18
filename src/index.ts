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
export type {
  ContentPart,
  MediaSource,
  Message,
  Role,
  RunInput,
  ToolCall,
  ToolSchema,
  Usage,
} from './shared/types'
export { addUsage, emptyUsage, partsToText } from './shared/types'

// Layer 4 — Tooling
export { BaseTool, defineTool, toToolSchema, ToolRegistry } from './tooling'
export type {
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprover,
  ToolContext,
  ToolDefinition,
} from './tooling'

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
export {
  approxTokenCounter,
  cacheModel,
  fitContext,
  InMemoryModelCache,
  PlanAndExecuteStrategy,
  ReActStrategy,
  withRetry,
} from './cognition'
export type {
  CacheModelOptions,
  GenerateOptions,
  InMemoryModelCacheOptions,
  LanguageModel,
  ModelCache,
  ModelResponse,
  ModelStreamChunk,
  Plan,
  PlanAndExecuteOptions,
  PlanContext,
  Planner,
  ReasoningInput,
  ReasoningResult,
  ReasoningStrategy,
  RetryOptions,
  StepTrace,
  TokenCounter,
  ToolTrace,
} from './cognition'

// Layer 6 — Memory
export {
<<<<<<< HEAD
  createModelSummarizer,
  createRememberTool,
  formatFacts,
  InMemoryMemory,
  MemoryStore,
  recallRelevantFacts,
=======
  composeMemory,
  createRememberTool,
  InMemoryMemory,
  MemoryStore,
>>>>>>> cacf14bab9bc9723a4adc8b0a8a1459623535d94
  SummarizingMemory,
} from './memory'
export type {
  ComposeMemoryOptions,
  ConversationMemory,
  FactMemory,
  FactSource,
  LoadHistoryOptions,
  Memory,
  MemoryFact,
  MemoryScope,
  MemoryStoreOptions,
  ModelSummarizerOptions,
  RecallOptions,
  RememberToolOptions,
  Summarizer,
  SummarizingMemoryOptions,
} from './memory'

// Layer 3 — Protocol
export { collectProviderTools, defineToolProvider } from './protocol'
export type { ToolProvider } from './protocol'

// Layer 7 (Application) + Layer 8 (Governance) — Observability hooks
export {
  BUILTIN_REDACTION_RULES,
  combineHooks,
  createRedactor,
  DEFAULT_GUARDRAIL_REFUSAL,
  evaluate,
  exactMatch,
  InMemoryUsageLimiter,
  includesText,
  matchesRegex,
  redactHooks,
  redactModel,
  usedTool,
  UsageTracker,
} from './observability'
export type {
  AgentEvent,
  AgentHooks,
  CaseResult,
  EvalCase,
  EvalReport,
  EvaluateOptions,
  EvalSample,
  GuardrailContext,
  GuardrailVerdict,
  InMemoryUsageLimiterOptions,
  InputGuardrail,
  LimiterContext,
  LimiterVerdict,
  OutputGuardrail,
  Redactor,
  RedactionRule,
  RedactorOptions,
  Score,
  Scorer,
  TextScorerOptions,
  UsageLimiter,
  UsageSnapshot,
} from './observability'

// Agent orchestrator + Layer 2 (Agent Internet)
export { Agent, AgentError, BaseAgent, InMemoryRunStore } from './agent'
export type {
  AgentConfig,
  IAgent,
  ResponseSchema,
  RunCheckpoint,
  RunOptions,
  RunResult,
  RunStore,
} from './agent'
export { agentAsTool } from './network'
export type { AgentAsToolOptions } from './network'
