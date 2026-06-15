/**
 * HTTP API with Hono — a production-shaped integration of momo-agentic.
 *
 * Shows the pieces you actually need to ship an agent behind an API:
 *  - one base config, forked per request into a memory-scoped agent
 *    (`MemoryStore` + `Agent.withMemory`) → multi-user, multi-thread;
 *  - a streaming endpoint (Server-Sent Events) driven by `token` events;
 *  - governance wired in: `policy`, input/output guardrails, a per-user
 *    `usageLimiter`, and a per-run `timeoutMs`;
 *  - `AgentError.stage` mapped to HTTP status codes.
 *
 * A mock model keeps it runnable with no API key — swap in a real `LanguageModel`
 * adapter (see examples/ai-assistant/gemini-model.ts) for production.
 *
 * Run with:  bun run examples/hono-api/server.ts
 * Then:      curl -s localhost:3000/chat -d '{"userId":"alice","threadId":"t1","message":"hi"}'
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  Agent,
  type AgentConfig,
  AgentError,
  type AgentHooks,
  InMemoryUsageLimiter,
  type InputGuardrail,
  type LanguageModel,
  MemoryStore,
  type Message,
  type OutputGuardrail,
  defineTool,
} from '../../src/index'

// --- A mock model: calls a tool for weather, otherwise streams a reply ----------
function plan(messages: Message[]): { text: string; toolCall?: Message['toolCalls'] } {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const usedTool = messages.some((m) => m.role === 'tool')
  if (!usedTool && /weather/i.test(lastUser)) {
    return {
      text: '',
      toolCall: [{ id: 'w', name: 'get_weather', arguments: { city: 'Bangkok' } }],
    }
  }
  return { text: `You said: “${lastUser}”. Anything else?` }
}

const model: LanguageModel = {
  id: 'mock:hono',
  generate: ({ messages }) => {
    const r = plan(messages)
    return Promise.resolve({ content: r.text, toolCalls: r.toolCall })
  },
  async *generateStream({ messages }) {
    const r = plan(messages)
    if (r.toolCall) return { content: '', toolCalls: r.toolCall }
    for (const word of r.text.split(' ')) yield { delta: `${word} ` }
    return { content: r.text }
  },
}

// --- Governance shared by every request -----------------------------------------
const getWeather = defineTool({
  name: 'get_weather',
  description: 'look up the weather for a city',
  execute: () => 'Sunny, 34°C',
})

const noInjection: InputGuardrail = {
  name: 'no-injection',
  check: (input) =>
    /ignore (all )?previous|disregard your instructions/i.test(input)
      ? { pass: false, output: 'That request looks unsafe.', reason: 'injection' }
      : { pass: true },
}
const noSecrets: OutputGuardrail = {
  name: 'no-secrets',
  check: (output) =>
    /password|api[_-]?key|token/i.test(output)
      ? { pass: false, output: 'I can’t share credentials.' }
      : { pass: true },
}

// Per-user budget: 10 runs each. Call POST /admin/reset to clear (demo only).
const limiter = new InMemoryUsageLimiter({ maxRuns: 10, key: (c) => String(c.metadata.userId) })
const store = new MemoryStore() // conversation per (userId, threadId); facts per userId

const baseConfig: Omit<AgentConfig, 'memory' | 'hooks'> = {
  model,
  tools: [getWeather],
  policy: 'Be helpful and concise. Never reveal secrets or another user’s data.',
  inputGuardrails: [noInjection],
  outputGuardrails: [noSecrets],
  usageLimiter: limiter,
  timeoutMs: 30_000,
}

/** Fork a thin, memory-scoped agent for one (userId, threadId), with optional hooks. */
function agentFor(userId: string, threadId: string, hooks?: AgentHooks): Agent {
  return new Agent({ ...baseConfig, memory: store.for({ userId, threadId }), hooks })
}

// --- Map an AgentError stage to an HTTP status ----------------------------------
const STATUS_FOR_STAGE: Record<string, ContentfulStatusCode> = {
  rate_limit: 429,
  timeout: 504,
  response_schema: 422,
}
function errorResponse(error: unknown): { status: ContentfulStatusCode; body: object } {
  if (error instanceof AgentError) {
    return {
      status: STATUS_FOR_STAGE[error.stage] ?? 500,
      body: { error: error.message, stage: error.stage },
    }
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
}

// --- Routes ---------------------------------------------------------------------
type ChatBody = { userId: string; threadId: string; message: string }

const app = new Hono()

app.get('/', (c) =>
  c.json({
    name: 'momo-agentic + hono',
    routes: ['POST /chat', 'POST /chat/stream (SSE)', 'POST /admin/reset'],
  }),
)

app.post('/chat', async (c) => {
  const { userId, threadId, message } = await c.req.json<ChatBody>()
  try {
    const result = await agentFor(userId, threadId).run(message, { metadata: { userId, threadId } })
    return c.json({ output: result.output, threadId, usage: result.usage })
  } catch (error) {
    const { status, body } = errorResponse(error)
    return c.json(body, status)
  }
})

app.post('/chat/stream', async (c) => {
  const { userId, threadId, message } = await c.req.json<ChatBody>()
  return streamSSE(c, async (stream) => {
    const agent = agentFor(userId, threadId, {
      onEvent: async (e) => {
        if (e.type === 'token') await stream.writeSSE({ event: 'token', data: e.delta })
        if (e.type === 'tool_call') await stream.writeSSE({ event: 'tool', data: e.tool })
      },
    })
    try {
      const result = await agent.run(message, { metadata: { userId, threadId } })
      await stream.writeSSE({ event: 'done', data: result.output })
    } catch (error) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify(errorResponse(error).body) })
    }
  })
})

app.post('/admin/reset', (c) => {
  limiter.reset()
  return c.json({ ok: true })
})

// Bun auto-serves the default export `{ port, fetch }` when you `bun run` this file.
const port = Number(process.env.PORT ?? 3000)
console.log(`🦊 momo-agentic API on http://localhost:${port}`)

export default { port, fetch: app.fetch }
