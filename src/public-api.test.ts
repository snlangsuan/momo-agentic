/**
 * Public API surface guard.
 *
 * Locks the package's exported surface so a future change can't silently remove
 * or rename something users depend on:
 *  - runtime: every value export must exist and be the right kind.
 *  - compile-time: every type export is referenced below, so removing/renaming
 *    one breaks `bun run typecheck`.
 *
 * Adding new exports is fine (this test won't fail); removing or renaming the
 * ones listed here will. When you intentionally change the public API, update
 * this file in the same commit.
 */
import { describe, expect, it } from 'bun:test'
import * as api from './index'

import type {
  AgentAsToolOptions,
  AgentConfig,
  AgentEvent,
  AgentHooks,
  ContentPart,
  ConversationMemory,
  FactMemory,
  FactSource,
  GenerateOptions,
  GuardrailContext,
  GuardrailVerdict,
  IAgent,
  InMemoryUsageLimiterOptions,
  InputGuardrail,
  LanguageModel,
  LimiterContext,
  LimiterVerdict,
  LoadHistoryOptions,
  MediaSource,
  Memory,
  MemoryFact,
  MemoryScope,
  MemoryStoreOptions,
  Message,
  ModelResponse,
  ModelStreamChunk,
  ModelSummarizerOptions,
  OutputGuardrail,
  Plan,
  PlanAndExecuteOptions,
  PlanContext,
  Planner,
  ReasoningInput,
  ReasoningResult,
  ReasoningStrategy,
  RecallOptions,
  RememberToolOptions,
  ResponseSchema,
  RetryOptions,
  Role,
  RunInput,
  RunOptions,
  RunResult,
  Skill,
  SkillDefinition,
  SkillManifest,
  StepTrace,
  Summarizer,
  SummarizingMemoryOptions,
  TokenCounter,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprover,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolProvider,
  ToolSchema,
  ToolTrace,
  Usage,
  UsageLimiter,
  UsageSnapshot,
} from './index'

/** Every runtime (value) export and its expected kind. */
const VALUE_EXPORTS: Record<string, 'function' | 'string' | 'object'> = {
  // shared
  addUsage: 'function',
  emptyUsage: 'function',
  partsToText: 'function',
  // tooling
  BaseTool: 'function',
  defineTool: 'function',
  toToolSchema: 'function',
  ToolRegistry: 'function',
  // tooling — skills
  BaseSkill: 'function',
  defineSkill: 'function',
  defineSkillFromManifest: 'function',
  parseSkillManifest: 'function',
  SkillRegistry: 'function',
  // cognition
  approxTokenCounter: 'object',
  fitContext: 'function',
  PlanAndExecuteStrategy: 'function',
  ReActStrategy: 'function',
  withRetry: 'function',
  // memory
  createModelSummarizer: 'function',
  createRememberTool: 'function',
  formatFacts: 'function',
  InMemoryMemory: 'function',
  MemoryStore: 'function',
  recallRelevantFacts: 'function',
  SummarizingMemory: 'function',
  // protocol
  collectProviderTools: 'function',
  defineToolProvider: 'function',
  // observability
  combineHooks: 'function',
  DEFAULT_GUARDRAIL_REFUSAL: 'string',
  InMemoryUsageLimiter: 'function',
  UsageTracker: 'function',
  // agent + network
  Agent: 'function',
  AgentError: 'function',
  BaseAgent: 'function',
  agentAsTool: 'function',
}

describe('public API surface', () => {
  it('exports every documented value with the expected kind', () => {
    const surface = api as unknown as Record<string, unknown>
    for (const [name, kind] of Object.entries(VALUE_EXPORTS)) {
      expect(surface[name], `missing export: ${name}`).toBeDefined()
      expect(typeof surface[name], `wrong kind for ${name}`).toBe(kind)
    }
  })

  it('classes are constructable / functions are callable as documented', () => {
    expect(api.emptyUsage()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(new api.InMemoryMemory().loadHistory()).toEqual([])
    expect(new api.MemoryStore().for({ userId: 'u', threadId: 't' }).loadHistory()).toEqual([])
    expect(new api.ToolRegistry().size).toBe(0)
    expect(new api.SkillRegistry().size).toBe(0)
    expect(new api.UsageTracker().snapshot().runs).toBe(0)
    expect(api.defineTool({ name: 't', description: 'd', execute: () => 'x' }).name).toBe('t')
  })
})

/**
 * Compile-time type-surface guard. Each public type is referenced here; if one
 * is removed or renamed, this file fails to typecheck. (Never executed.)
 */
// biome-ignore lint/suspicious/noExportsInTest: this export is a compile-time type-surface guard, not runtime code
export type _PublicTypeSurface = {
  Message: Message
  Role: Role
  ContentPart: ContentPart
  MediaSource: MediaSource
  RunInput: RunInput
  ToolCall: ToolCall
  ToolSchema: ToolSchema
  Usage: Usage
  Tool: Tool
  ToolApprover: ToolApprover
  ToolApprovalRequest: ToolApprovalRequest
  ToolApprovalDecision: ToolApprovalDecision
  ToolContext: ToolContext
  ToolDefinition: ToolDefinition<Record<string, unknown>>
  Skill: Skill
  SkillDefinition: SkillDefinition
  SkillManifest: SkillManifest
  GenerateOptions: GenerateOptions
  GuardrailContext: GuardrailContext
  GuardrailVerdict: GuardrailVerdict
  OutputGuardrail: OutputGuardrail
  LanguageModel: LanguageModel
  ModelResponse: ModelResponse
  ModelStreamChunk: ModelStreamChunk
  Plan: Plan
  PlanAndExecuteOptions: PlanAndExecuteOptions
  PlanContext: PlanContext
  Planner: Planner
  ReasoningInput: ReasoningInput
  ReasoningResult: ReasoningResult
  ReasoningStrategy: ReasoningStrategy
  ResponseSchema: ResponseSchema
  RetryOptions: RetryOptions
  TokenCounter: TokenCounter
  StepTrace: StepTrace
  ToolTrace: ToolTrace
  ConversationMemory: ConversationMemory
  FactMemory: FactMemory
  FactSource: FactSource
  LoadHistoryOptions: LoadHistoryOptions
  Memory: Memory
  MemoryFact: MemoryFact
  MemoryScope: MemoryScope
  MemoryStoreOptions: MemoryStoreOptions
  ModelSummarizerOptions: ModelSummarizerOptions
  RecallOptions: RecallOptions
  RememberToolOptions: RememberToolOptions
  Summarizer: Summarizer
  SummarizingMemoryOptions: SummarizingMemoryOptions
  ToolProvider: ToolProvider
  AgentEvent: AgentEvent
  AgentHooks: AgentHooks
  InputGuardrail: InputGuardrail
  UsageLimiter: UsageLimiter
  LimiterContext: LimiterContext
  LimiterVerdict: LimiterVerdict
  InMemoryUsageLimiterOptions: InMemoryUsageLimiterOptions
  UsageSnapshot: UsageSnapshot
  AgentConfig: AgentConfig
  IAgent: IAgent
  RunOptions: RunOptions
  RunResult: RunResult
  AgentAsToolOptions: AgentAsToolOptions
}
