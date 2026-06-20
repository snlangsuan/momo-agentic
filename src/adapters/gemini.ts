import type {
  GenerateOptions,
  LanguageModel,
  ModelResponse,
  ModelStreamChunk,
} from '@/cognition/model'
import type { ContentPart, MediaSource, Message, ToolCall } from '@/shared/types'
/**
 * Layer 5 — Cognition adapter for Google Gemini, built on the official
 * `@google/genai` SDK.
 *
 * One adapter, BOTH backends the SDK exposes — selected by the options shape:
 *  - **Gemini Developer API** (`vertexai` omitted/false): authenticate with an
 *    API key.
 *  - **Vertex AI** (`vertexai: true`): authenticate with Application Default
 *    Credentials, scoped to a GCP `project` + `location`.
 *
 * It maps momo-agentic's neutral message/tool shapes to Gemini's
 * `contents` / `functionDeclarations` / `functionCall` / `functionResponse`
 * format and back, including token usage and streaming.
 *
 * `@google/genai` is an OPTIONAL peer dependency: it is pulled in only when you
 * import `momo-agentic/gemini`. The core library stays dependency-free.
 */
import { type Content, GoogleGenAI, type Part } from '@google/genai'

/** Options for {@link createGeminiModel}. The `vertexai` flag picks the backend. */
export type GeminiModelOptions =
  | {
      /** Gemini Developer API (default). */
      vertexai?: false
      /** API key for the Gemini Developer API. */
      apiKey: string
      /** Model id. Defaults to `"gemini-3.0-pro"`. */
      model?: string
      temperature?: number
    }
  | {
      /** Vertex AI backend (auth via Application Default Credentials). */
      vertexai: true
      /** GCP project id. */
      project: string
      /** GCP location, e.g. `"us-central1"` or `"global"`. */
      location: string
      /** Model id. Defaults to `"gemini-3.0-pro"`. */
      model?: string
      temperature?: number
    }

/** A tool-result string becomes a Gemini `functionResponse` object. */
function toResponseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { result: parsed }
  } catch {
    return { result: text }
  }
}

/** Parts for an assistant turn: its text plus any function calls it made. */
function assistantParts(m: Message): Part[] {
  const parts: Part[] = []
  if (m.content) parts.push({ text: m.content })
  for (const call of m.toolCalls ?? []) {
    const part: Part = { functionCall: { name: call.name, args: call.arguments } }
    // Echo Gemini's per-call thought signature back, unchanged. Gemini rejects
    // (HTTP 400) a function-call turn replayed without its `thoughtSignature`.
    const signature = call.providerMetadata?.thoughtSignature
    if (typeof signature === 'string') part.thoughtSignature = signature
    parts.push(part)
  }
  return parts.length > 0 ? parts : [{ text: '' }]
}

/** A media source → a Gemini Part (`fileData` for URLs, `inlineData` for base64). */
function mediaPart(source: MediaSource): Part {
  if (source.url) {
    return { fileData: { fileUri: source.url, mimeType: source.mimeType } }
  }
  return {
    inlineData: {
      data: source.data ?? '',
      mimeType: source.mimeType ?? 'application/octet-stream',
    },
  }
}

/** Map momo-agentic multimodal parts to Gemini Parts. */
function userParts(m: Message): Part[] {
  if (!m.parts?.length) return [{ text: m.content }]
  return m.parts.map((part: ContentPart): Part => {
    switch (part.type) {
      case 'text':
        return { text: part.text }
      default:
        return mediaPart(part.source)
    }
  })
}

/** Map one neutral message to a Gemini Content (system messages return null). */
function toContent(m: Message): Content | null {
  switch (m.role) {
    case 'user':
      return { role: 'user', parts: userParts(m) }
    case 'assistant':
      return { role: 'model', parts: assistantParts(m) }
    case 'tool':
      return {
        role: 'user',
        parts: [
          { functionResponse: { name: m.name ?? 'tool', response: toResponseObject(m.content) } },
        ],
      }
    default:
      return null // system is collected separately into systemInstruction
  }
}

/** Convert the neutral transcript into a Gemini system instruction + contents. */
function toGemini(messages: Message[]): { system?: string; contents: Content[] } {
  const system = messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => m.content)
    .join('\n\n')
  const contents = messages.map(toContent).filter((c): c is Content => c !== null)
  return { system: system || undefined, contents }
}

/** Gemini `functionCall` parts → neutral {@link ToolCall}s (synthesizing ids). */
function toToolCalls(
  calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>,
  offset = 0,
): ToolCall[] {
  return calls.map((call, i) => ({
    id: call.id ?? `${call.name ?? 'tool'}-${offset + i}`,
    name: call.name ?? 'tool',
    arguments: call.args ?? {},
  }))
}

/**
 * Extract tool calls from a response candidate's raw parts, capturing each
 * function call's `thoughtSignature` into {@link ToolCall.providerMetadata} so
 * it can be replayed on the next request (see {@link assistantParts}). The
 * `functionCalls` convenience accessor drops these signatures, so we read the
 * parts directly. Falls back to `fallback` when no candidate parts are present.
 */
function readToolCalls(
  parts: Part[] | undefined,
  fallback: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> | undefined,
  offset = 0,
): ToolCall[] {
  const fromParts: ToolCall[] = []
  for (const part of parts ?? []) {
    const fc = part.functionCall
    if (!fc) continue
    const call: ToolCall = {
      id: fc.id ?? `${fc.name ?? 'tool'}-${offset + fromParts.length}`,
      name: fc.name ?? 'tool',
      arguments: fc.args ?? {},
    }
    if (typeof part.thoughtSignature === 'string') {
      call.providerMetadata = { thoughtSignature: part.thoughtSignature }
    }
    fromParts.push(call)
  }
  if (fromParts.length > 0) return fromParts
  return toToolCalls(fallback ?? [], offset)
}

function toUsage(meta?: {
  promptTokenCount?: number
  candidatesTokenCount?: number
}): ModelResponse['usage'] {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
  }
}

/**
 * Build a Gemini-backed {@link LanguageModel} (Gemini Developer API or Vertex AI).
 *
 * @example Gemini Developer API
 * ```ts
 * import { createGeminiModel } from 'momo-agentic/gemini'
 * const model = createGeminiModel({ apiKey: process.env.GEMINI_API_KEY! })
 * ```
 *
 * @example Vertex AI
 * ```ts
 * const model = createGeminiModel({ vertexai: true, project: 'my-proj', location: 'us-central1' })
 * ```
 */
export function createGeminiModel(options: GeminiModelOptions): LanguageModel {
  const model = options.model ?? 'gemini-3.0-pro'
  const temperature = options.temperature ?? 0.7
  const ai = options.vertexai
    ? new GoogleGenAI({ vertexai: true, project: options.project, location: options.location })
    : new GoogleGenAI({ apiKey: options.apiKey })

  const config = (
    system: string | undefined,
    tools: GenerateOptions['tools'],
    signal?: AbortSignal,
  ) => ({
    temperature,
    ...(signal ? { abortSignal: signal } : {}),
    ...(system ? { systemInstruction: system } : {}),
    ...(tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        }
      : {}),
  })

  return {
    id: model,
    generate: async ({ messages, tools, signal }): Promise<ModelResponse> => {
      const { system, contents } = toGemini(messages)
      const response = await ai.models.generateContent({
        model,
        contents,
        config: config(system, tools, signal),
      })
      const toolCalls = readToolCalls(
        response.candidates?.[0]?.content?.parts,
        response.functionCalls,
      )
      return {
        content: response.text ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: toUsage(response.usageMetadata),
      }
    },
    generateStream: async function* ({
      messages,
      tools,
      signal,
    }): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
      const { system, contents } = toGemini(messages)
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: config(system, tools, signal),
      })
      let content = ''
      const toolCalls: ToolCall[] = []
      let usage: ModelResponse['usage']
      for await (const chunk of stream) {
        const text = chunk.text
        if (text) {
          content += text
          yield { delta: text }
        }
        const calls = readToolCalls(
          chunk.candidates?.[0]?.content?.parts,
          chunk.functionCalls,
          toolCalls.length,
        )
        if (calls.length > 0) toolCalls.push(...calls)
        if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata)
      }
      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
      }
    },
  }
}
