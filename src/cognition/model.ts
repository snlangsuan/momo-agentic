/**
 * Layer 5 — Cognition (model port).
 *
 * The single integration point for an LLM provider. Implement this to bridge
 * any vendor SDK (Claude, OpenAI-compatible, local, a mock for tests) into the
 * reasoning loop. This is the seam that keeps Infrastructure (Layer 1) out of
 * the library core.
 */
import type { Message, ToolSchema, Usage } from '../shared/types'
import type { ToolCall } from '../shared/types'

/** Options passed to the model on each completion step. */
export interface GenerateOptions {
  messages: Message[]
  tools: ToolSchema[]
  signal?: AbortSignal
}

/** What the model returns for one completion step. */
export interface ModelResponse {
  /** Assistant text for this step (may be empty if only tool calls). */
  content: string
  /** Tool calls the model wants executed before continuing. */
  toolCalls?: ToolCall[]
  /** Token usage for this step, if the provider reports it. */
  usage?: Partial<Usage>
}

/** Provider port: produce one completion step given a transcript and tools. */
export interface LanguageModel {
  /** Human-readable identifier, e.g. `"claude-opus-4-8"`. */
  readonly id: string
  generate(options: GenerateOptions): Promise<ModelResponse>
}
