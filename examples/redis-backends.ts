/**
 * Redis-backed persistence (the `momo-agentic/redis` entry point).
 *
 * Three ready-to-use Redis backends:
 *  - `RedisMemory`     — short-term conversation + long-term facts
 *  - `RedisModelCache` — shared LLM response cache for `cacheModel`
 *  - `RedisRunStore`   — durable run checkpoints (cross-process resume)
 *
 * In production you pass a real client — `new Redis(process.env.REDIS_URL)`.
 * To keep THIS file runnable with no server, it uses a tiny in-process stand-in
 * for the handful of `ioredis` commands the backends call.
 *
 * Run with:  bun run examples/redis-backends.ts
 */
import type { Redis } from 'ioredis'
import { Agent, type LanguageModel, cacheModel } from '../src/index'
// In your app: import { RedisMemory, RedisModelCache, RedisRunStore } from 'momo-agentic/redis'
import { RedisMemory, RedisModelCache, RedisRunStore } from '../src/redis/index'

// --- a minimal in-process Redis (swap for `new Redis(url)`) -----------------
class FakeRedis {
  private d = new Map<string, unknown>()
  get = (k: string) => Promise.resolve((this.d.get(k) as string) ?? null)
  set = (k: string, v: string) => {
    this.d.set(k, v)
    return Promise.resolve('OK' as const)
  }
  del = (k: string) => Promise.resolve(this.d.delete(k) ? 1 : 0)
  expire = () => Promise.resolve(1)
  rpush = (k: string, ...v: string[]) => {
    const l = (this.d.get(k) as string[]) ?? []
    l.push(...v)
    this.d.set(k, l)
    return Promise.resolve(l.length)
  }
  lrange = (k: string, start: number, stop: number) => {
    const l = (this.d.get(k) as string[]) ?? []
    const s = start < 0 ? Math.max(l.length + start, 0) : start
    const e = stop < 0 ? l.length + stop : stop
    return Promise.resolve(l.slice(s, e + 1))
  }
  hset = (k: string, f: string, v: string) => {
    const h = (this.d.get(k) as Record<string, string>) ?? {}
    h[f] = v
    this.d.set(k, h)
    return Promise.resolve(1)
  }
  hgetall = (k: string) => Promise.resolve((this.d.get(k) as Record<string, string>) ?? {})
}
const redis = new FakeRedis() as unknown as Redis

// === 1) RedisMemory — conversation persists across turns ====================
const echo: LanguageModel = {
  id: 'echo',
  generate: ({ messages }) => {
    const turns = messages.filter((m) => m.role === 'user').length
    return Promise.resolve({ content: `(turn ${turns}) noted` })
  },
}
const memory = new RedisMemory(redis, { namespace: 'chat:u1:t1', ttlSeconds: 86_400 })
const agent = new Agent({ model: echo, memory })

await agent.run('my name is Decimo')
await agent.run('what did I say?')
const history = await memory.loadHistory()
console.log('🧠 RedisMemory — stored transcript:')
for (const m of history) console.log(`   ${m.role}: ${m.content}`)

// === 2) RedisModelCache — identical request served from Redis ===============
let providerCalls = 0
const provider: LanguageModel = {
  id: 'p',
  generate: () => {
    providerCalls++
    return Promise.resolve({ content: 'Paris', usage: { inputTokens: 10, outputTokens: 1 } })
  },
}
const cached = cacheModel(provider, { cache: new RedisModelCache(redis, { ttlSeconds: 3600 }) })
const req = { messages: [{ role: 'user' as const, content: 'capital of France?' }], tools: [] }
await cached.generate(req)
await cached.generate(req) // identical → cache hit
console.log(`\n⚡ RedisModelCache — provider called ${providerCalls}× for 2 identical requests`)

// === 3) RedisRunStore — durable checkpoint wired into the agent =============
const store = new RedisRunStore(redis)
await new Agent({ model: echo, memory, runStore: store }).run('checkpoint me', { runId: 'job-1' })
console.log(
  `\n💾 RedisRunStore — checkpoint after success: ${(await store.load('job-1')) ?? 'cleared'}`,
)
