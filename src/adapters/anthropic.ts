import type {
  GenerateOptions,
  LanguageModel,
  ModelResponse,
  ModelStreamChunk,
} from '@/cognition/model'
import type { ContentPart, MediaSource, Message, ToolCall } from '@/shared/types'
/**
 * Layer 5 — Cognition adapter for Anthropic Claude, built on the official
 * `@anthropic-ai/sdk` (Messages API).
 *
 * It maps momo-agentic's neutral message/tool shapes to Claude's
 * `system` / `messages` / `tools` / `tool_use` / `tool_result` format and back,
 * including token usage and streaming.
 *
 * Notes on the Messages API that shape this adapter:
 *  - System prompts are a top-level `system` field, not a message — system
 *    messages in the transcript are collected and joined into it.
 *  - `max_tokens` is required on every request (defaults to 4096 here).
 *  - On Claude Opus 4.8 / 4.7 (and Fable 5) the sampling parameters
 *    (`temperature`, `top_p`, `top_k`) are rejected with a 400, so `temperature`
 *    is sent ONLY when explicitly provided.
 *
 * `@anthropic-ai/sdk` is an OPTIONAL peer dependency: it is pulled in only when
 * you import `momo-agentic/anthropic`. The core library stays dependency-free.
 */
import Anthropic from '@anthropic-ai/sdk'

type MessageParam = Anthropic.MessageParam
type ContentBlockParam = Anthropic.ContentBlockParam
type ImageBlockParam = Anthropic.ImageBlockParam
type Tool = Anthropic.Tool

/** Options for {@link createAnthropicModel}. */
export interface AnthropicModelOptions {
  /** API key for the Anthropic API. */
  apiKey: string
  /** Model id. Defaults to `"claude-opus-4-8"`. */
  model?: string
  /** Override the API base URL (e.g. a gateway or proxy). */
  baseURL?: string
  /** Extra headers (e.g. beta flags, gateway attribution). */
  headers?: Record<string, string>
  /** Max tokens to generate per request. Required by the API; defaults to 4096. */
  maxTokens?: number
  /**
   * Sampling temperature. Sent ONLY when set — newer Claude models (Opus 4.8 /
   * 4.7, Fable 5) reject `temperature` with a 400, so it is omitted by default.
   */
  temperature?: number
}

/** Build a Claude image block from a media source (URL or base64). */
function imagePart(source: MediaSource): ImageBlockParam {
  if (source.url) {
    return { type: 'image', source: { type: 'url', url: source.url } }
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      // biome-ignore lint/suspicious/noExplicitAny: media_type is a constrained enum the caller supplies freely
      media_type: (source.mimeType ?? 'image/png') as any,
      data: source.data ?? '',
    },
  }
}

/** Map momo-agentic multimodal parts to Claude content blocks. */
function userContent(m: Message): string | ContentBlockParam[] {
  if (!m.parts?.length) return m.content
  return m.parts.map((part: ContentPart): ContentBlockParam => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image') return imagePart(part.source)
    // audio/video/file are not first-class Messages-API blocks — keep a marker.
    return { type: 'text', text: `[${part.type}]` }
  })
}

/** Content blocks for an assistant turn: its text plus any tool calls it made. */
function assistantContent(m: Message): string | ContentBlockParam[] {
  if (!m.toolCalls?.length) return m.content
  const blocks: ContentBlockParam[] = []
  if (m.content) blocks.push({ type: 'text', text: m.content })
  for (const call of m.toolCalls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
  }
  return blocks
}

/** Map one neutral message to a Claude message param (system messages return null). */
function toMessage(m: Message): MessageParam | null {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: userContent(m) }
    case 'assistant':
      return { role: 'assistant', content: assistantContent(m) }
    case 'tool':
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      }
    default:
      return null // system is collected separately into the top-level `system` field
  }
}

/** Split the neutral transcript into a Claude system string + messages array. */
function toAnthropic(messages: Message[]): { system?: string; messages: MessageParam[] } {
  const system = messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => m.content)
    .join('\n\n')
  const mapped = messages.map(toMessage).filter((m): m is MessageParam => m !== null)
  return { system: system || undefined, messages: mapped }
}

/** Map neutral tool schemas to Claude `tools`. */
function toTools(tools: GenerateOptions['tools']): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }))
}

/** Claude `tool_use` content blocks → neutral {@link ToolCall}s. */
function toToolCalls(content: Anthropic.ContentBlock[]): ToolCall[] {
  const calls: ToolCall[] = []
  for (const block of content) {
    if (block.type === 'tool_use') {
      calls.push({
        id: block.id,
        name: block.name,
        arguments: (block.input as Record<string, unknown>) ?? {},
      })
    }
  }
  return calls
}

/** Concatenate the text content blocks of a Claude message. */
function toText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Build an Anthropic Claude-backed {@link LanguageModel}.
 *
 * @example
 * ```ts
 * import { createAnthropicModel } from 'momo-agentic/anthropic'
 * const model = createAnthropicModel({ apiKey: process.env.ANTHROPIC_API_KEY! })
 * ```
 */
export function createAnthropicModel(options: AnthropicModelOptions): LanguageModel {
  const model = options.model ?? 'claude-opus-4-8'
  const maxTokens = options.maxTokens ?? 4096
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.headers,
  })

  const body = (messages: Message[], tools: GenerateOptions['tools']) => {
    const { system, messages: msgs } = toAnthropic(messages)
    return {
      model,
      max_tokens: maxTokens,
      messages: msgs,
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools: toTools(tools) } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }
  }

  return {
    id: model,
    generate: async ({ messages, tools, signal }): Promise<ModelResponse> => {
      const message = await client.messages.create(
        { ...body(messages, tools), stream: false },
        { signal },
      )
      const toolCalls = toToolCalls(message.content)
      return {
        content: toText(message.content),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      }
    },
    generateStream: async function* ({
      messages,
      tools,
      signal,
    }): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
      const stream = client.messages.stream(body(messages, tools), { signal })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { delta: event.delta.text }
        }
      }
      const message = await stream.finalMessage()
      const toolCalls = toToolCalls(message.content)
      return {
        content: toText(message.content),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      }
    },
  }
}
