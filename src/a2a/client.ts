import { extractText } from '@/a2a/mapping'
import type { A2AAgentCard, A2AArtifactUpdateEvent, A2APart, JsonRpcResponse } from '@/a2a/types'
/**
 * A2A client — call a REMOTE A2A agent as a local {@link Tool}.
 *
 * The network counterpart to `agentAsTool`: fetch a remote agent's Card, then
 * expose it as a tool whose `execute` sends `message/send` (or `message/stream`)
 * over JSON-RPC and returns the answer. A lead agent can delegate across the
 * network (or across organizations) just by adding the tool. Dependency-free.
 */
import type { Tool } from '@/tooling/tool'

/** A connectable {@link fetch}; defaults to the global. Inject for tests/proxies. */
export type FetchLike = typeof fetch

/** Options for {@link a2aAgentAsTool}. */
export interface A2AAgentAsToolOptions {
  /** Tool name. Defaults to the remote agent's name (sanitized). */
  name?: string
  /** Tool description shown to the model. Defaults to the Card's description. */
  description?: string
  /** Extra headers sent on every request (e.g. `Authorization` for secured agents). */
  headers?: Record<string, string>
  /** Use `message/stream` (SSE) instead of `message/send`, aggregating the answer. */
  stream?: boolean
  /** Inject a custom fetch (proxy, auth, tests). */
  fetch?: FetchLike
}

const toToolName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'remote_agent'

/** Fetch and parse a remote {@link A2AAgentCard} from its discovery URL. */
export async function fetchAgentCard(
  cardUrl: string,
  fetchImpl: FetchLike = fetch,
  headers?: Record<string, string>,
): Promise<A2AAgentCard> {
  const res = await fetchImpl(cardUrl, { method: 'GET', ...(headers ? { headers } : {}) })
  if (!res.ok) throw new Error(`Failed to fetch Agent Card (${res.status}) from ${cardUrl}`)
  return (await res.json()) as A2AAgentCard
}

/** Read an SSE response, returning the JSON-RPC `result` of each event. */
async function readSseResults(res: Response): Promise<unknown[]> {
  const results: unknown[] = []
  const body = res.body
  if (!body) return results
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const line = block.split('\n').find((l) => l.startsWith('data:'))
      const data = line?.slice(5).trim()
      if (data && data !== '[DONE]') {
        const envelope = JSON.parse(data) as JsonRpcResponse
        if (envelope.result !== undefined) results.push(envelope.result)
      }
      sep = buffer.indexOf('\n\n')
    }
  }
  return results
}

/** Concatenate the text of all artifact-update chunks from a streamed run. */
const aggregateStream = (results: unknown[]): string =>
  results
    .filter(
      (r): r is A2AArtifactUpdateEvent => (r as { kind?: string })?.kind === 'artifact-update',
    )
    .flatMap((event) => event.artifact.parts)
    .filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('')

/**
 * Build a {@link Tool} that delegates to a remote A2A agent (discovered via its
 * Agent Card URL).
 *
 * @example
 * ```ts
 * const remote = await a2aAgentAsTool('https://other-org/agent/.well-known/agent-card.json', {
 *   headers: { Authorization: `Bearer ${token}` },
 *   stream: true,
 * })
 * const lead = new Agent({ model, tools: [remote] })
 * ```
 */
export async function a2aAgentAsTool(
  cardUrl: string,
  options: A2AAgentAsToolOptions = {},
): Promise<Tool> {
  const fetchImpl = options.fetch ?? fetch
  const headers = { 'content-type': 'application/json', ...options.headers }
  const card = await fetchAgentCard(cardUrl, fetchImpl, options.headers)
  const endpoint = card.url
  const method = options.stream ? 'message/stream' : 'message/send'

  return {
    name: options.name ?? toToolName(card.name),
    description:
      options.description ?? card.description ?? `Delegate a request to the ${card.name} agent.`,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: `The request to send to the ${card.name} agent.` },
      },
      required: ['message'],
    },
    execute: async (args, context) => {
      const text = String((args as { message?: unknown }).message ?? '')
      const request = {
        jsonrpc: '2.0' as const,
        id: crypto.randomUUID(),
        method,
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: crypto.randomUUID(),
            parts: [{ kind: 'text', text }],
          },
        },
      }
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: context.signal,
      })
      if (!res.ok) throw new Error(`A2A request to ${card.name} failed (${res.status})`)

      if (options.stream) return aggregateStream(await readSseResults(res))

      const body = (await res.json()) as JsonRpcResponse
      if (body.error) throw new Error(`A2A error from ${card.name}: ${body.error.message}`)
      return extractText(body.result)
    },
  }
}
