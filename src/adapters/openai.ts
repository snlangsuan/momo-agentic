import type {
  GenerateOptions,
  LanguageModel,
  ModelResponse,
  ModelStreamChunk,
} from '@/cognition/model'
import type { ContentPart, MediaSource, Message, ToolCall } from '@/shared/types'
/**
 * Layer 5 — Cognition adapter for OpenAI and OpenAI-compatible providers, built
 * on the official `openai` SDK (Chat Completions API).
 *
 * The same adapter drives any service that speaks the OpenAI wire format — point
 * `baseURL` at it: Azure OpenAI, Groq, Together, OpenRouter, Mistral, a local
 * Ollama / vLLM / LM Studio server, etc. It maps momo-agentic's neutral
 * message/tool shapes to `messages` / `tools` / `tool_calls` and back, including
 * token usage and streaming (with incremental tool-call assembly).
 *
 * `openai` is an OPTIONAL peer dependency: it is pulled in only when you import
 * `momo-agentic/openai`. The core library stays dependency-free.
 */
import OpenAI from 'openai'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool
type ChatContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart

/** Options for {@link createOpenAIModel}. Set `baseURL` for OpenAI-compatible hosts. */
export interface OpenAIModelOptions {
  /** Model id, e.g. `"gpt-4o-mini"` or a provider-specific id for compatible hosts. */
  model: string
  /** API key. Optional for local servers that don't require one. */
  apiKey?: string
  /** Override the API base URL for OpenAI-compatible providers. */
  baseURL?: string
  /** Extra headers (e.g. for OpenRouter attribution, Azure, gateways). */
  headers?: Record<string, string>
  organization?: string
  temperature?: number
  maxTokens?: number
}

/** Parse a tool-call argument string; returns `{}` on empty/malformed input. */
function parseArguments(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Build a `data:` URL for inline base64 media, or pass a remote URL through. */
function mediaUrl(source: MediaSource): string {
  if (source.url) return source.url
  return `data:${source.mimeType ?? 'application/octet-stream'};base64,${source.data ?? ''}`
}

/** Map a multimodal part to an OpenAI content part (text + images; others noted). */
function toContentPart(part: ContentPart): ChatContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') return { type: 'image_url', image_url: { url: mediaUrl(part.source) } }
  // audio/video/file are not first-class Chat Completions parts — keep a marker.
  return { type: 'text', text: `[${part.type}]` }
}

/** Map one neutral message to an OpenAI message param. */
function toMessage(m: Message): ChatMessage {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
    case 'assistant': {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content || null,
      }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }))
      }
      return msg
    }
    default:
      return m.parts?.length
        ? { role: 'user', content: m.parts.map(toContentPart) }
        : { role: 'user', content: m.content }
  }
}

/** Map neutral tool schemas to OpenAI `tools`. */
function toTools(tools: GenerateOptions['tools']): ChatTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/**
 * Build an OpenAI-backed {@link LanguageModel}. Works with OpenAI directly, or
 * with any OpenAI-compatible provider via `baseURL`.
 *
 * @example OpenAI
 * ```ts
 * import { createOpenAIModel } from 'momo-agentic/openai'
 * const model = createOpenAIModel({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' })
 * ```
 *
 * @example OpenAI-compatible (e.g. local Ollama)
 * ```ts
 * const model = createOpenAIModel({ baseURL: 'http://localhost:11434/v1', model: 'llama3.1' })
 * ```
 */
export function createOpenAIModel(options: OpenAIModelOptions): LanguageModel {
  const client = new OpenAI({
    apiKey: options.apiKey ?? 'not-set',
    baseURL: options.baseURL,
    organization: options.organization,
    defaultHeaders: options.headers,
  })
  const { model, temperature, maxTokens } = options

  const body = (messages: Message[], tools: GenerateOptions['tools']) => ({
    model,
    messages: messages.map(toMessage),
    ...(tools.length > 0 ? { tools: toTools(tools) } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  })

  return {
    id: model,
    generate: async ({ messages, tools, signal }): Promise<ModelResponse> => {
      const completion = await client.chat.completions.create(
        { ...body(messages, tools), stream: false },
        { signal },
      )
      const message = completion.choices[0]?.message
      const toolCalls: ToolCall[] = []
      for (const tc of message?.tool_calls ?? []) {
        if (tc.type !== 'function') continue
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: parseArguments(tc.function.arguments),
        })
      }
      return {
        content: message?.content ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      }
    },
    generateStream: async function* ({
      messages,
      tools,
      signal,
    }): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
      const stream = await client.chat.completions.create(
        { ...body(messages, tools), stream: true, stream_options: { include_usage: true } },
        { signal },
      )
      let content = ''
      const acc = new Map<number, { id: string; name: string; args: string }>()
      let usage: ModelResponse['usage']
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          content += delta.content
          yield { delta: delta.content }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = acc.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
          acc.set(tc.index, slot)
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          }
        }
      }
      const toolCalls: ToolCall[] = [...acc.values()].map((t, i) => ({
        id: t.id || `call_${i}`,
        name: t.name,
        arguments: parseArguments(t.args),
      }))
      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
      }
    },
  }
}
