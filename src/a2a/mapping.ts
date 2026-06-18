/**
 * Translation between A2A wire shapes and momo-agentic primitives.
 */
import type { ContentPart, RunInput } from '../shared/types'
import type { A2AArtifact, A2AFilePart, A2APart, A2ATask, JsonRpcResponse } from './types'

const mediaType = (mimeType?: string): 'image' | 'audio' | 'video' | 'file' => {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType?.startsWith('video/')) return 'video'
  return 'file'
}

const filePartToContent = (file: A2AFilePart['file']): ContentPart => {
  const source = file.uri
    ? { url: file.uri, mimeType: file.mimeType }
    : { data: file.bytes ?? '', mimeType: file.mimeType }
  const type = mediaType(file.mimeType)
  return type === 'file' ? { type: 'file', source, name: file.name } : { type, source }
}

const partToContent = (part: A2APart): ContentPart => {
  if (part.kind === 'text') return { type: 'text', text: part.text }
  if (part.kind === 'data') return { type: 'text', text: JSON.stringify(part.data) }
  return filePartToContent(part.file)
}

/** Map A2A message parts to a momo {@link RunInput} (text-only collapses to a string). */
export function partsToRunInput(parts: A2APart[]): RunInput {
  const content = parts.map(partToContent)
  if (content.length === 1 && content[0]?.type === 'text') return content[0].text
  return content
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value }

/** Build an A2A artifact from an agent's text answer plus optional structured data. */
export function resultToArtifact(output: string, data?: unknown): A2AArtifact {
  const parts: A2APart[] = [{ kind: 'text', text: output }]
  if (data !== undefined) parts.push({ kind: 'data', data: asRecord(data) })
  return { artifactId: 'artifact-1', name: 'response', parts }
}

/** Concatenate the text parts of a Task's artifacts (or a returned Message). */
export function extractText(result: unknown): string {
  const collect = (parts: A2APart[] | undefined): string =>
    (parts ?? [])
      .filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('')

  const value = result as Partial<A2ATask> & { parts?: A2APart[] }
  if (value?.kind === 'task') {
    return (value.artifacts ?? [])
      .map((a) => collect(a.parts))
      .join('\n')
      .trim()
  }
  // A returned Message (some agents answer without creating a task).
  return collect(value?.parts)
}

export const rpcResult = (id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
})

export const rpcError = (
  id: JsonRpcResponse['id'],
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })
