import { type A2AServer, a2aAgentAsTool, serveA2A } from '../src/a2a/index'
/**
 * A2A over a REAL HTTP server (Bun.serve) — production-shaped wiring.
 *
 * Unlike examples/a2a.ts (which routes the client's fetch straight into the
 * handler in-process), this stands up an actual HTTP server: it serves the Agent
 * Card at `/.well-known/agent-card.json` and the JSON-RPC endpoint at `/a2a`, then
 * a client discovers and calls it over real HTTP + SSE on localhost. Swap the
 * mock model for a real provider and this is deployable as-is.
 *
 * Run with:  bun run examples/a2a-server.ts
 */
import { Agent, defineTool } from '../src/index'
import { fnModel } from './_support/mock-model'

// --- the agent we expose ----------------------------------------------------
const getTime = defineTool<{ city: string }>({
  name: 'get_time',
  description: 'Current local time for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: ({ city }) => ({ city, time: '09:00' }),
})
const clock = new Agent({
  name: 'clock-agent',
  model: fnModel('clock', (opts) => {
    const answered = opts.messages.some((m) => m.role === 'tool')
    return answered
      ? { content: 'It is 09:00 in Bangkok.' }
      : { content: '', toolCalls: [{ id: '1', name: 'get_time', arguments: { city: 'Bangkok' } }] }
  }),
  tools: [getTime],
})

// --- a real HTTP server -----------------------------------------------------
// (a holder lets the fetch closure see the A2A server, built after we know the port)
const ref: { a2a?: A2AServer } = {}
const server = Bun.serve({
  port: 0, // OS-assigned free port
  fetch(req) {
    const a2a = ref.a2a
    if (!a2a) return new Response('starting', { status: 503 })
    const { pathname } = new URL(req.url)
    if (pathname === '/.well-known/agent-card.json') return Response.json(a2a.card)
    if (pathname === '/a2a') return a2a.handle(req)
    return new Response('not found', { status: 404 })
  },
})
const base = `http://localhost:${server.port}`
ref.a2a = serveA2A(clock, { url: `${base}/a2a`, version: '1.0.0', description: 'Tells the time.' })
console.log(`🌐 A2A agent serving at ${base}`)

const cardUrl = `${base}/.well-known/agent-card.json`

// --- 1) discovery over HTTP -------------------------------------------------
const card = await (await fetch(cardUrl)).json()
console.log(`🪪 discovered "${card.name}" — streaming:${card.capabilities.streaming}`)

// --- 2) a lead agent delegates to it over HTTP ------------------------------
const remote = await a2aAgentAsTool(cardUrl) // real fetch, real network
const lead = new Agent({
  name: 'lead',
  model: fnModel('lead', (opts) => {
    const delegated = opts.messages.some((m) => m.role === 'tool')
    return delegated
      ? { content: `Relayed: ${opts.messages.find((m) => m.role === 'tool')?.content}` }
      : {
          content: '',
          toolCalls: [{ id: '1', name: remote.name, arguments: { message: 'time in Bangkok?' } }],
        }
  }),
  tools: [remote],
})
const answer = await lead.run('What time is it in Bangkok?')
console.log('🤖 lead:', answer.output)

// --- 3) stream the answer over real SSE -------------------------------------
const streamReq = {
  jsonrpc: '2.0',
  id: 's',
  method: 'message/stream',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      parts: [{ kind: 'text', text: 'time?' }],
    },
  },
}
const sse = await fetch(`${base}/a2a`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(streamReq),
})
process.stdout.write('📡 stream: ')
for (const block of (await sse.text()).split('\n\n')) {
  if (!block.startsWith('data:')) continue
  const ev = JSON.parse(block.slice(5).trim()).result
  if (ev.kind === 'status-update') console.log(`(${ev.status.state})`)
  else if (ev.kind === 'artifact-update')
    process.stdout.write(ev.artifact.parts.map((p: { text?: string }) => p.text ?? '').join(''))
}

server.stop()
