/**
 * Shared, layer-neutral primitives used across every layer.
 *
 * These are deliberately tiny and free of behavior so that no layer depends on
 * another's implementation — only on these contracts.
 */

/** A role within a conversation transcript. */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** A piece of media referenced by URL or inline base64 data. */
export interface MediaSource {
  /** Remote URL of the media. */
  url?: string
  /** Base64-encoded inline data (without the `data:` prefix). */
  data?: string
  /** MIME type, e.g. `"image/png"`, `"audio/mpeg"`, `"video/mp4"`. */
  mimeType?: string
}

/** One part of a multimodal message — text or a media attachment. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: MediaSource }
  | { type: 'audio'; source: MediaSource }
  | { type: 'video'; source: MediaSource }
  | { type: 'file'; source: MediaSource; name?: string }

/** Agent input: plain text, or a list of multimodal parts (image/audio/video/file + text). */
export type RunInput = string | ContentPart[]

/** Concatenate the text parts of a multimodal input (media parts are ignored). */
export function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/** A request, emitted by the model, to invoke a tool. */
export interface ToolCall {
  /** Stable id used to correlate the call with its result. */
  id: string
  /** Name of the tool to invoke; must match a registered tool. */
  name: string
  /** Parsed arguments for the tool, keyed by parameter name. */
  arguments: Record<string, unknown>
}

/** A single message in the conversation transcript. */
export interface Message {
  role: Role
  /** Text content. May be empty when the assistant only emits tool calls. */
  content: string
  /**
   * Multimodal parts for this message (image/audio/video/file + text). When set,
   * a {@link LanguageModel} adapter should send these to the provider; `content`
   * holds the text-only fallback. Typically present only on user messages.
   */
  parts?: ContentPart[]
  /** Tool calls requested by the assistant (role === 'assistant'). */
  toolCalls?: ToolCall[]
  /** Correlates a tool-result message back to its {@link ToolCall} (role === 'tool'). */
  toolCallId?: string
  /** Name of the tool that produced a tool-result message (role === 'tool'). */
  name?: string
}

/**
 * Provider-neutral description of a tool, shaped as JSON Schema so it is
 * compatible with MCP, OpenAI, and Gemini function-calling alike.
 */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema describing the tool's parameters object. */
  parameters: Record<string, unknown>
}

/** Token accounting for a run, summed across reasoning steps. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** A zeroed {@link Usage} accumulator. */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

/** Add `delta` into `target` in place and return it. */
export function addUsage(target: Usage, delta?: Partial<Usage>): Usage {
  if (!delta) return target
  target.inputTokens += delta.inputTokens ?? 0
  target.outputTokens += delta.outputTokens ?? 0
  target.totalTokens += delta.totalTokens ?? (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0)
  return target
}
