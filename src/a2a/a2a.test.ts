import { describe, expect, it } from 'bun:test'
import { a2aAgentAsTool } from '@/a2a/client'
import { extractText, partsToRunInput } from '@/a2a/mapping'
import { serveA2A } from '@/a2a/server'
import { InMemoryA2ATaskStore } from '@/a2a/task-store'
import type { A2AStatusUpdateEvent, A2ATask, JsonRpcResponse } from '@/a2a/types'
import type { IAgent, RunResult } from '@/agent/types'
import { Agent, type LanguageModel, type RunInput, emptyUsage } from '@/index'
import { ScriptedModel } from '@/test-support/scripted-model'

const result = (output: string): RunResult => ({
  output,
  returns: [],
  trace: [],
  messages: [],
  steps: 1,
  usage: emptyUsage(),
  usageByModel: {},
  toolsInvoked: [],
  skillsUsed: [],
})

/** A fake agent that echoes its input text. */
const echoAgent = (name: string): IAgent => ({
  name,
  run: (input: RunInput) =>
    Promise.resolve(result(`[${name}] ${typeof input === 'string' ? input : ''}`)),
})

const sendRequest = (message: string) => ({
  jsonrpc: '2.0',
  id: 'req-1',
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'text', text: message }],
    },
  },
})

const post = (server: ReturnType<typeof serveA2A>, body: unknown) =>
  server.handle(new Request('https://x/a2a', { method: 'POST', body: JSON.stringify(body) }))

describe('serveA2A — Agent Card', () => {
  it('builds a discovery card from the agent + options', () => {
    const { card } = serveA2A(echoAgent('researcher'), {
      url: 'https://me/a2a',
      version: '1.2.0',
      description: 'researches things',
    })
    expect(card).toMatchObject({
      name: 'researcher',
      url: 'https://me/a2a',
      version: '1.2.0',
      capabilities: { streaming: true },
    })
    expect(card.skills[0]?.id).toBe('default')
  })
})

describe('serveA2A — message/send', () => {
  it('runs the agent and returns a completed Task with an artifact', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'https://me/a2a', version: '1' })
    const res = await post(server, sendRequest('hello'))
    const body = (await res.json()) as JsonRpcResponse
    const task = body.result as {
      kind: string
      status: { state: string }
      artifacts: { parts: { text: string }[] }[]
    }

    expect(body.id).toBe('req-1')
    expect(task.kind).toBe('task')
    expect(task.status.state).toBe('completed')
    expect(task.artifacts[0]?.parts[0]?.text).toBe('[bot] hello')
  })

  it('rejects an unknown method with JSON-RPC -32601', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await post(server, { jsonrpc: '2.0', id: 9, method: 'agent/teleport' })
    const body = (await res.json()) as JsonRpcResponse
    expect(body.error?.code).toBe(-32601)
  })

  it('reports an agent failure as a JSON-RPC error', async () => {
    const failing: IAgent = { name: 'x', run: () => Promise.reject(new Error('boom')) }
    const server = serveA2A(failing, { url: 'u', version: '1' })
    const body = (await (await post(server, sendRequest('hi'))).json()) as JsonRpcResponse
    expect(body.error?.message).toBe('boom')
  })
})

describe('serveA2A — message/stream', () => {
  it('streams working → artifact → completed as SSE', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await post(server, { ...sendRequest('hi'), method: 'message/stream' })
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const events = (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data:'))
      .map(
        (b) =>
          (JSON.parse(b.slice(5).trim()) as JsonRpcResponse).result as {
            kind: string
            status?: { state: string }
          },
      )

    expect(events.map((e) => e.kind)).toEqual(['task', 'artifact-update', 'status-update'])
    expect(events[0]?.status?.state).toBe('working')
    expect(events[2]?.status?.state).toBe('completed')
  })
})

describe('a2aAgentAsTool — round-trip through serveA2A', () => {
  // Route the client's fetch straight into the server handler (no network).
  const connect = (server: ReturnType<typeof serveA2A>): typeof fetch =>
    ((url: string | URL | Request, init?: RequestInit) => {
      if (!init || init.method === 'GET') return Promise.resolve(Response.json(server.card))
      return server.handle(new Request(String(url), init))
    }) as typeof fetch

  it('exposes a remote agent as a tool that delegates over A2A', async () => {
    const server = serveA2A(echoAgent('researcher'), {
      url: 'https://remote/a2a',
      version: '1',
      description: 'does research',
    })
    const tool = await a2aAgentAsTool('https://remote/.well-known/agent-card.json', {
      fetch: connect(server),
    })

    expect(tool.name).toBe('researcher')
    expect(tool.description).toBe('does research')
    const out = await tool.execute(
      { message: 'capital of Thailand?' },
      { agentName: 'lead', metadata: {} },
    )
    expect(out).toBe('[researcher] capital of Thailand?')
  })

  it('a lead Agent delegates to the remote agent through the tool', async () => {
    const server = serveA2A(echoAgent('specialist'), { url: 'https://remote/a2a', version: '1' })
    const tool = await a2aAgentAsTool('https://remote/.well-known/agent-card.json', {
      fetch: connect(server),
    })
    const lead = new Agent({
      model: new ScriptedModel([
        {
          content: '',
          toolCalls: [{ id: '1', name: 'specialist', arguments: { message: 'ask remote' } }],
        },
        { content: 'relayed' },
      ]),
      tools: [tool],
    })

    const res = await lead.run('go')
    expect(res.toolsInvoked).toContain('specialist')
    expect(res.trace.flatMap((s) => s.tools).map((t) => t.result)).toContain(
      '[specialist] ask remote',
    )
  })
})

// A model that streams its answer token-by-token (drives `token` events).
const streamingModel = (text: string): LanguageModel => ({
  id: 'streamer',
  generate: () => Promise.resolve({ content: text }),
  async *generateStream() {
    for (const word of text.split(' ')) yield { delta: `${word} ` }
    return { content: text }
  },
})

describe('serveA2A — Phase 2: token streaming', () => {
  it('streams token deltas as append artifact-update chunks', async () => {
    const agent = new Agent({ model: streamingModel('one two three') })
    const server = serveA2A(agent, { url: 'u', version: '1' })
    const res = await post(server, { ...sendRequest('go'), method: 'message/stream' })

    const events = (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data:'))
      .map(
        (b) => (JSON.parse(b.slice(5).trim()) as JsonRpcResponse).result as Record<string, unknown>,
      )

    const chunks = events.filter((e) => e.kind === 'artifact-update')
    // one append chunk per streamed token + a terminal marker
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const text = chunks
      .flatMap((c) => (c.artifact as { parts: { text?: string }[] }).parts)
      .map((p) => p.text ?? '')
      .join('')
    expect(text).toContain('one')
    expect(text).toContain('three')
    expect((events.at(-1) as unknown as A2AStatusUpdateEvent).status.state).toBe('completed')
  })
})

describe('serveA2A — Phase 2: tasks/get + tasks/cancel', () => {
  it('persists a completed task and retrieves it via tasks/get', async () => {
    const store = new InMemoryA2ATaskStore()
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1', taskStore: store })

    const sendBody = (await (await post(server, sendRequest('hi'))).json()) as JsonRpcResponse
    const taskId = (sendBody.result as A2ATask).id

    const got = (await (
      await post(server, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: taskId } })
    ).json()) as JsonRpcResponse
    expect((got.result as A2ATask).status.state).toBe('completed')
  })

  it('tasks/get returns task-not-found for an unknown id', async () => {
    const server = serveA2A(echoAgent('bot'), {
      url: 'u',
      version: '1',
      taskStore: new InMemoryA2ATaskStore(),
    })
    const body = (await (
      await post(server, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'nope' } })
    ).json()) as JsonRpcResponse
    expect(body.error?.code).toBe(-32001)
  })

  it('tasks/get errors when no taskStore is configured', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const body = (await (
      await post(server, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } })
    ).json()) as JsonRpcResponse
    expect(body.error?.code).toBe(-32601)
  })

  it('tasks/cancel aborts an in-flight task', async () => {
    let abortedDuringRun = false
    const slow: IAgent = {
      name: 'slow',
      run: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            abortedDuringRun = true
            reject(new Error('aborted'))
          })
        }),
    }
    const store = new InMemoryA2ATaskStore()
    const server = serveA2A(slow, { url: 'u', version: '1', taskStore: store })

    const message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-9',
      parts: [{ kind: 'text', text: 'hi' }],
    }
    const sendPromise = post(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message },
    })

    // Let message/send register its in-flight controller before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Cancel the known task id while message/send is still running.
    const cancel = (await (
      await post(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: 'task-9' },
      })
    ).json()) as JsonRpcResponse
    expect((cancel.result as A2ATask).status.state).toBe('canceled')

    const sendBody = (await (await sendPromise).json()) as JsonRpcResponse
    expect(abortedDuringRun).toBe(true)
    expect((sendBody.result as A2ATask).status.state).toBe('canceled')
  })
})

describe('a2a mapping', () => {
  it('maps file (url→image), inline (base64→file), and data parts', () => {
    expect(
      partsToRunInput([
        { kind: 'text', text: 'hi' },
        { kind: 'file', file: { uri: 'https://x/c.png', mimeType: 'image/png' } },
        { kind: 'file', file: { bytes: 'B64', mimeType: 'application/pdf', name: 'd.pdf' } },
        { kind: 'data', data: { a: 1 } },
      ]),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { url: 'https://x/c.png', mimeType: 'image/png' } },
      { type: 'file', source: { data: 'B64', mimeType: 'application/pdf' }, name: 'd.pdf' },
      { type: 'text', text: '{"a":1}' },
    ])
  })

  it('collapses a single text part to a string', () => {
    expect(partsToRunInput([{ kind: 'text', text: 'just text' }])).toBe('just text')
  })

  it('extractText reads a returned Message (no Task wrapper)', () => {
    expect(extractText({ kind: 'message', parts: [{ kind: 'text', text: 'hello' }] })).toBe('hello')
  })
})

describe('serveA2A — error paths', () => {
  it('parse error on a malformed JSON body (-32700)', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await server.handle(new Request('https://x', { method: 'POST', body: 'not json' }))
    expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(-32700)
  })

  it('message/send without parts (-32602)', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await post(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: 'm' } },
    })
    expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(-32602)
  })

  it('tasks/cancel for an unknown task (-32001)', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await post(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/cancel',
      params: { id: 'nope' },
    })
    expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(-32001)
  })

  it('pushNotificationConfig/get for an unknown task (-32001)', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const res = await post(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/pushNotificationConfig/get',
      params: { id: 'nope' },
    })
    expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(-32001)
  })
})

const routeTo = (server: ReturnType<typeof serveA2A>): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) =>
    !init || init.method === 'GET'
      ? Promise.resolve(Response.json(server.card))
      : server.handle(new Request(String(url), init))) as typeof fetch

describe('serveA2A — Phase 3: push notifications', () => {
  it('POSTs the final task to the configured webhook', async () => {
    const pushed: Array<{ url: string; body: unknown }> = []
    const recorder: typeof fetch = ((url: string, init?: RequestInit) => {
      pushed.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Promise.resolve(Response.json({ ok: true }))
    }) as typeof fetch
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1', fetch: recorder })

    await post(server, {
      ...sendRequest('hi'),
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'm',
          taskId: 't-1',
          parts: [{ kind: 'text', text: 'hi' }],
        },
        configuration: { pushNotificationConfig: { url: 'https://hook/cb', token: 'sek' } },
      },
    })

    expect(pushed[0]?.url).toBe('https://hook/cb')
    expect((pushed[0]?.body as A2ATask).status.state).toBe('completed')
    expect(server.card.capabilities.pushNotifications).toBe(true)
  })

  it('set/get a push config via tasks/pushNotificationConfig/*', async () => {
    const server = serveA2A(echoAgent('bot'), { url: 'u', version: '1' })
    const cfg = { url: 'https://hook/x' }
    await post(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/pushNotificationConfig/set',
      params: { taskId: 'k', pushNotificationConfig: cfg },
    })
    const got = (await (
      await post(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/pushNotificationConfig/get',
        params: { id: 'k' },
      })
    ).json()) as JsonRpcResponse
    expect(
      (got.result as { pushNotificationConfig: { url: string } }).pushNotificationConfig.url,
    ).toBe('https://hook/x')
  })
})

describe('serveA2A — Phase 3: input-required', () => {
  it('ends in input-required when needsInput returns true', async () => {
    const asker: IAgent = {
      name: 'asker',
      run: () => Promise.resolve(result('What is your name?')),
    }
    const server = serveA2A(asker, {
      url: 'u',
      version: '1',
      needsInput: (r) => r.output.trim().endsWith('?'),
    })
    const body = (await (await post(server, sendRequest('hi'))).json()) as JsonRpcResponse
    expect((body.result as A2ATask).status.state).toBe('input-required')
  })
})

describe('a2aAgentAsTool — Phase 3: streaming client + auth', () => {
  it('aggregates a streamed answer when stream: true', async () => {
    const agent = new Agent({ model: streamingModel('Bangkok is the capital') })
    const server = serveA2A(agent, { url: 'https://r/a2a', version: '1' })
    const tool = await a2aAgentAsTool('https://r/.well-known/agent-card.json', {
      stream: true,
      fetch: routeTo(server),
    })
    const out = await tool.execute({ message: 'capital?' }, { agentName: 'lead', metadata: {} })
    expect(out).toContain('Bangkok')
    expect(out).toContain('capital')
  })

  it('forwards auth headers on every request', async () => {
    const server = serveA2A(echoAgent('secure'), { url: 'https://r/a2a', version: '1' })
    const seen: Array<Record<string, string> | undefined> = []
    const capturing: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined)
      return routeTo(server)(url, init)
    }) as typeof fetch

    const tool = await a2aAgentAsTool('https://r/.well-known/agent-card.json', {
      headers: { authorization: 'Bearer tok' },
      fetch: capturing,
    })
    await tool.execute({ message: 'hi' }, { agentName: 'lead', metadata: {} })

    expect(seen.some((h) => h?.authorization === 'Bearer tok')).toBe(true)
  })
})

describe('serveA2A — Phase 3: Agent Card security', () => {
  it('advertises securitySchemes + security', () => {
    const { card } = serveA2A(echoAgent('bot'), {
      url: 'u',
      version: '1',
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    })
    expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } })
    expect(card.security).toEqual([{ bearer: [] }])
  })
})

describe('serveA2A — Phase 2: contextId → agent resolver', () => {
  it('resolves a per-context agent (scope memory by contextId)', async () => {
    const seen: string[] = []
    const server = serveA2A(
      (contextId) => {
        seen.push(contextId)
        return echoAgent(`ctx-${contextId}`)
      },
      { url: 'u', version: '1', name: 'router' },
    )
    const message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      contextId: 'user-7',
      parts: [{ kind: 'text', text: 'hi' }],
    }
    const body = (await (
      await post(server, { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message } })
    ).json()) as JsonRpcResponse

    expect(seen).toEqual(['user-7'])
    expect((body.result as A2ATask).artifacts?.[0]?.parts[0]).toMatchObject({
      text: '[ctx-user-7] hi',
    })
    expect(server.card.name).toBe('router')
  })
})
