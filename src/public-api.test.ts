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
  GenerateOptions,
  IAgent,
  LanguageModel,
  LoadHistoryOptions,
  MediaSource,
  Memory,
  MemoryFact,
  Message,
  ModelResponse,
  Plan,
  PlanContext,
  Planner,
  ReasoningInput,
  ReasoningResult,
  ReasoningStrategy,
  RememberToolOptions,
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
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolProvider,
  ToolSchema,
  ToolTrace,
  Usage,
  UsageSnapshot,
} from './index'

/** Every runtime (value) export and its expected kind. */
const VALUE_EXPORTS: Record<string, 'function'> = {
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
  ReActStrategy: 'function',
  // memory
  createRememberTool: 'function',
  InMemoryMemory: 'function',
  SummarizingMemory: 'function',
  // protocol
  collectProviderTools: 'function',
  defineToolProvider: 'function',
  // observability
  combineHooks: 'function',
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
  ToolContext: ToolContext
  ToolDefinition: ToolDefinition<Record<string, unknown>>
  Skill: Skill
  SkillDefinition: SkillDefinition
  SkillManifest: SkillManifest
  GenerateOptions: GenerateOptions
  LanguageModel: LanguageModel
  ModelResponse: ModelResponse
  Plan: Plan
  PlanContext: PlanContext
  Planner: Planner
  ReasoningInput: ReasoningInput
  ReasoningResult: ReasoningResult
  ReasoningStrategy: ReasoningStrategy
  StepTrace: StepTrace
  ToolTrace: ToolTrace
  ConversationMemory: ConversationMemory
  FactMemory: FactMemory
  LoadHistoryOptions: LoadHistoryOptions
  Memory: Memory
  MemoryFact: MemoryFact
  RememberToolOptions: RememberToolOptions
  Summarizer: Summarizer
  SummarizingMemoryOptions: SummarizingMemoryOptions
  ToolProvider: ToolProvider
  AgentEvent: AgentEvent
  AgentHooks: AgentHooks
  UsageSnapshot: UsageSnapshot
  AgentConfig: AgentConfig
  IAgent: IAgent
  RunOptions: RunOptions
  RunResult: RunResult
  AgentAsToolOptions: AgentAsToolOptions
}
