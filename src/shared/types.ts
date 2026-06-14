/**
 * Shared, layer-neutral primitives used across every layer.
 *
 * These are deliberately tiny and free of behavior so that no layer depends on
 * another's implementation — only on these contracts.
 */

/** A role within a conversation transcript. */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

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
