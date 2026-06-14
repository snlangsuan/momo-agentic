/**
 * A real {@link LanguageModel} adapter for Google Gemini (3.0 family), built on
 * the official `@google/genai` SDK.
 *
 * It maps momo-agentic's neutral message/tool shapes to Gemini's
 * `contents` / `functionDeclarations` / `functionCall` / `functionResponse`
 * format and back, including token usage. Tool parameters are passed through as
 * `parametersJsonSchema` since momo-agentic tools already use JSON Schema.
 */
import { type Content, GoogleGenAI, type Part } from '@google/genai'
import type {
  ContentPart,
  GenerateOptions,
  LanguageModel,
  MediaSource,
  Message,
  ModelResponse,
  ToolCall,
} from '../../src/index'

/** A tool result string is wrapped as a Gemini functionResponse object. */
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
    parts.push({ functionCall: { name: call.name, args: call.arguments } })
  }
  return parts.length > 0 ? parts : [{ text: '' }]
}

/** A media source → a Gemini Part (fileData for URLs, inlineData for base64). */
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
        // image / audio / video / file all carry a `source`.
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

export interface GeminiModelOptions {
  apiKey: string
  /** Model id, e.g. a Gemini 3.0 model. Defaults to `"gemini-3.0-pro"`. */
  model?: string
  temperature?: number
}

/** Build a Gemini-backed {@link LanguageModel} using `@google/genai`. */
export function geminiModel(options: GeminiModelOptions): LanguageModel {
  const model = options.model ?? 'gemini-3.0-pro'
  const ai = new GoogleGenAI({ apiKey: options.apiKey })

  return {
    id: model,
    generate: async ({ messages, tools, signal }: GenerateOptions): Promise<ModelResponse> => {
      const { system, contents } = toGemini(messages)

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          temperature: options.temperature ?? 0.7,
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
        },
      })

      const calls = response.functionCalls ?? []
      const toolCalls: ToolCall[] = calls.map((call, i) => ({
        // Gemini calls may omit an id; synthesize a stable one for correlation.
        id: call.id ?? `${call.name ?? 'tool'}-${i}`,
        name: call.name ?? 'tool',
        arguments: (call.args ?? {}) as Record<string, unknown>,
      }))

      return {
        content: response.text ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      }
    },
  }
}
