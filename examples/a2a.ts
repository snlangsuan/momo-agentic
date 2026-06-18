import { InMemoryA2ATaskStore, a2aAgentAsTool, serveA2A } from '../src/a2a/index'
/**
 * A2A (Agent2Agent) interop — the `momo-agentic/a2a` entry point.
 *
 * Two directions, both shown here end-to-end with no network:
 *  - `serveA2A(agent)`    — expose a momo agent so OTHER agents can call it
 *  - `a2aAgentAsTool(url)` — call a remote A2A agent as a local tool (delegation)
 *
 * A "lead" agent delegates a research question to a separate "specialist" agent
 * over the A2A protocol. In production the lead and specialist run on different
 * hosts/orgs; here the client's fetch is routed straight into the server handler.
 *
 * Run with:  bun run examples/a2a.ts
 */
import { Agent, type LanguageModel, defineTool } from '../src/index'

// === 1) The SPECIALIST agent, exposed over A2A ==============================
const lookup = defineTool<{ topic: string }>({
  name: 'lookup',
  description: 'Look up a fact.',
  parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
  execute: ({ topic }) => (/thai/i.test(topic) ? 'Bangkok' : 'unknown'),
})
const specialistModel: LanguageModel = {
  id: 'specialist',
  generate: ({ messages }) => {
    const asked = messages.some((m) => m.role === 'tool')
    return Promise.resolve(
      asked
        ? { content: 'The capital of Thailand is Bangkok.' }
        : {
            content: '',
            toolCalls: [{ id: '1', name: 'lookup', arguments: { topic: 'thailand' } }],
          },
    )
  },
}
const specialist = new Agent({ name: 'geo-specialist', model: specialistModel, tools: [lookup] })

const server = serveA2A(specialist, {
  url: 'https://geo.example/a2a',
  version: '1.0.0',
  description: 'Answers geography questions.',
})
console.log(
  '🪪 Agent Card:',
  JSON.stringify({ name: server.card.name, skills: server.card.skills.length }, null, 0),
)

// Route the lead's fetch into the server handler (stands in for the network).
const network: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
  !init || init.method === 'GET'
    ? Promise.resolve(Response.json(server.card))
    : server.handle(new Request(String(url), init))) as typeof fetch

// === 2) The LEAD agent delegates to the specialist via A2A =================
const remote = await a2aAgentAsTool('https://geo.example/.well-known/agent-card.json', {
  fetch: network,
})

const leadModel: LanguageModel = {
  id: 'lead',
  generate: ({ messages }) => {
    const delegated = messages.some((m) => m.role === 'tool')
    return Promise.resolve(
      delegated
        ? { content: 'According to the geo specialist: Bangkok.' }
        : {
            content: '',
            toolCalls: [
              { id: '1', name: remote.name, arguments: { message: 'capital of Thailand?' } },
            ],
          },
    )
  },
}
const lead = new Agent({
  name: 'lead',
  model: leadModel,
  tools: [remote],
  hooks: {
    onEvent: (e) => e.type === 'tool_call' && console.log(`  🛰️  delegating via A2A → ${e.tool}`),
  },
})

const answer = await lead.run('What is the capital of Thailand?')
console.log('🤖 lead answer:', answer.output)
console.log('   delegated to:', answer.toolsInvoked)

// === 3) Phase 2: token streaming (message/stream) + tasks/get ==============
const streamer = new Agent({
  name: 'streamer',
  model: {
    id: 'streamer',
    generate: () => Promise.resolve({ content: 'Bangkok is the capital.' }),
    async *generateStream() {
      for (const w of 'Bangkok is the capital.'.split(' ')) yield { delta: `${w} ` }
      return { content: 'Bangkok is the capital.' }
    },
  },
})
const streamServer = serveA2A(streamer, {
  url: 'https://geo.example/a2a',
  version: '1.0.0',
  taskStore: new InMemoryA2ATaskStore(),
})
const streamReq = {
  jsonrpc: '2.0',
  id: 's1',
  method: 'message/stream',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-7',
      parts: [{ kind: 'text', text: 'capital?' }],
    },
  },
}
const sse = await streamServer.handle(
  new Request('https://x', { method: 'POST', body: JSON.stringify(streamReq) }),
)
process.stdout.write('\n📡 streamed: ')
for (const block of (await sse.text()).split('\n\n')) {
  if (!block.startsWith('data:')) continue
  const ev = JSON.parse(block.slice(5).trim()).result
  if (ev.kind === 'artifact-update')
    process.stdout.write(ev.artifact.parts.map((p: { text?: string }) => p.text ?? '').join(''))
}
const got = await streamServer.handle(
  new Request('https://x', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'g',
      method: 'tasks/get',
      params: { id: 'task-7' },
    }),
  }),
)
console.log(
  `\n📂 tasks/get task-7 → ${((await got.json()).result as { status: { state: string } }).status.state}`,
)

// === 4) Phase 3: push notification (webhook fired on completion) ===========
const webhook: typeof fetch = ((url: string, init?: RequestInit) => {
  const t = JSON.parse(String(init?.body)) as { status: { state: string } }
  console.log(`\n🔔 webhook ${url} ← task ${t.status.state}`)
  return Promise.resolve(Response.json({ ok: true }))
}) as typeof fetch
const pushServer = serveA2A(specialist, {
  url: 'https://geo.example/a2a',
  version: '1.0.0',
  fetch: webhook,
})
await pushServer.handle(
  new Request('https://x', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'p1',
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'm',
          taskId: 'task-async',
          parts: [{ kind: 'text', text: 'capital of Thailand?' }],
        },
        configuration: { pushNotificationConfig: { url: 'https://my-app/callback' } },
      },
    }),
  }),
)
