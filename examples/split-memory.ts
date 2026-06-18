/**
 * Split memory tiers across stores (Layer 6).
 *
 * The two memory ports are independent, so `composeMemory` can put SHORT-TERM
 * conversation in one store and LONG-TERM facts in another — here Redis for the
 * transcript (fast, TTL'd) and Mongo for durable facts.
 *
 *   import { composeMemory } from 'momo-agentic'
 *   import { RedisMemory } from 'momo-agentic/redis'
 *   import { MongoMemory } from 'momo-agentic/mongo'
 *
 *   const memory = composeMemory({
 *     conversation: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}` }),
 *     facts: new MongoMemory(db, { namespace: `user:${userId}` }),
 *   })
 *
 * This file uses tiny in-process stand-ins for the redis/mongo clients so it runs
 * with no servers — swap in `new Redis(url)` / `MongoClient` in production.
 *
 * Run with:  bun run examples/split-memory.ts
 */
import type { Redis } from 'ioredis'
import type { Db } from 'mongodb'
import { Agent, type LanguageModel, composeMemory } from '../src/index'
import { MongoMemory } from '../src/mongo/index'
import { RedisMemory } from '../src/redis/index'

// --- in-process fakes (replace with real clients) ---------------------------
class FakeRedis {
  private d = new Map<string, string[]>()
  rpush = (k: string, ...v: string[]) => {
    const l = this.d.get(k) ?? []
    l.push(...v)
    this.d.set(k, l)
    return Promise.resolve(l.length)
  }
  lrange = (k: string, start: number, stop: number) => {
    const l = this.d.get(k) ?? []
    const s = start < 0 ? Math.max(l.length + start, 0) : start
    const e = stop < 0 ? l.length + stop : stop
    return Promise.resolve(l.slice(s, e + 1))
  }
  expire = () => Promise.resolve(1)
}

class FakeDb {
  private store = new Map<string, Record<string, unknown>>()
  collection() {
    const store = this.store
    return {
      find: () => ({
        sort: () => ({
          limit: () => ({ toArray: () => Promise.resolve([]) }),
          toArray: () => Promise.resolve([]),
        }),
      }),
      insertOne: () => Promise.resolve({ acknowledged: true }),
      findOne: (f: { _id: string }) => Promise.resolve(store.get(f._id) ?? null),
      updateOne: (f: { _id: string }, u: { $set?: Record<string, unknown> }) => {
        const doc = store.get(f._id) ?? { _id: f._id, facts: {} as Record<string, unknown> }
        for (const [k, v] of Object.entries(u.$set ?? {})) {
          const field = k.replace('facts.', '')
          ;(doc.facts as Record<string, unknown>)[field] = v
        }
        store.set(f._id, doc)
        return Promise.resolve({ acknowledged: true })
      },
    }
  }
}

const redis = new FakeRedis() as unknown as Redis
const db = new FakeDb() as unknown as Db

// --- compose: short-term Redis + long-term Mongo ----------------------------
const memory = composeMemory({
  conversation: new RedisMemory(redis, { namespace: 'chat:u1:t1', ttlSeconds: 86_400 }),
  facts: new MongoMemory(db, { namespace: 'user:u1' }),
})

const model: LanguageModel = {
  id: 'echo',
  generate: ({ messages }) => {
    const turns = messages.filter((m) => m.role === 'user').length
    return Promise.resolve({ content: `noted (turn ${turns})` })
  },
}
const agent = new Agent({ model, memory, rememberFacts: true })

await agent.run('hi, I am Decimo from Bangkok')
await memory.rememberFact?.('name', 'Decimo')
await memory.rememberFact?.('city', 'Bangkok')
await agent.run('what do you know about me?')

console.log('🟥 short-term (Redis) — transcript:')
for (const m of await memory.loadHistory()) console.log(`   ${m.role}: ${m.content}`)
console.log('\n🍃 long-term (Mongo) — facts:', await memory.recallFacts?.())
