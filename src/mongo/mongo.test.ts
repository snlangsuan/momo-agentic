import { describe, expect, it } from 'bun:test'
import { Agent, InMemoryMemory, type LanguageModel, composeMemory } from '@/index'
import { MongoMemory } from '@/mongo/memory'
import type { Db } from 'mongodb'

// --- a tiny in-process stand-in for the `mongodb` ops MongoMemory uses -------
type Doc = Record<string, unknown>

const matches = (doc: Doc, filter: Doc) => Object.entries(filter).every(([k, v]) => doc[k] === v)
const setDot = (doc: Doc, path: string, value: unknown) => {
  const parts = path.split('.')
  let cur = doc
  for (const key of parts.slice(0, -1)) {
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
    cur = cur[key] as Doc
  }
  cur[parts[parts.length - 1] as string] = value
}

class FakeCollection {
  readonly docs: Doc[] = []
  private seq = 0

  find(filter: Doc) {
    let rows = this.docs.filter((d) => matches(d, filter))
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        const [key, dir] = Object.entries(spec)[0] as [string, number]
        rows = [...rows].sort((a, b) => ((a[key] as number) - (b[key] as number)) * dir)
        return cursor
      },
      limit: (n: number) => {
        rows = rows.slice(0, n)
        return cursor
      },
      toArray: () => Promise.resolve(rows),
    }
    return cursor
  }
  insertOne(doc: Doc) {
    this.docs.push({ _id: ++this.seq, ...doc })
    return Promise.resolve({ acknowledged: true })
  }
  findOne(filter: Doc) {
    return Promise.resolve(this.docs.find((d) => matches(d, filter)) ?? null)
  }
  updateOne(filter: Doc, update: { $set?: Doc }, options?: { upsert?: boolean }) {
    let doc = this.docs.find((d) => matches(d, filter))
    if (!doc && options?.upsert) {
      doc = { ...filter }
      this.docs.push(doc)
    }
    if (doc) for (const [k, v] of Object.entries(update.$set ?? {})) setDot(doc, k, v)
    return Promise.resolve({ acknowledged: true })
  }
}

class FakeDb {
  private readonly cols = new Map<string, FakeCollection>()
  collection(name: string): FakeCollection {
    const existing = this.cols.get(name)
    if (existing) return existing
    const created = new FakeCollection()
    this.cols.set(name, created)
    return created
  }
}

const fakeDb = () => new FakeDb() as unknown as Db

describe('MongoMemory', () => {
  it('appends and loads conversation in insertion order', async () => {
    const memory = new MongoMemory(fakeDb(), { namespace: 'user:1' })
    await memory.appendMessage({ role: 'user', content: 'a' })
    await memory.appendMessage({ role: 'assistant', content: 'b' })
    expect((await memory.loadHistory()).map((m) => m.content)).toEqual(['a', 'b'])
  })

  it('honors a limit (most recent N, oldest → newest)', async () => {
    const memory = new MongoMemory(fakeDb(), { namespace: 'n' })
    for (const c of ['a', 'b', 'c']) await memory.appendMessage({ role: 'user', content: c })
    expect((await memory.loadHistory({ limit: 2 })).map((m) => m.content)).toEqual(['b', 'c'])
  })

  it('stores and recalls durable facts (upsert)', async () => {
    const memory = new MongoMemory(fakeDb(), { namespace: 'user:1' })
    await memory.rememberFact('name', 'Decimo')
    await memory.rememberFact('city', 'Bangkok')
    expect(await memory.recallFacts()).toEqual({ name: 'Decimo', city: 'Bangkok' })
  })

  it('isolates scopes by namespace', async () => {
    const db = fakeDb()
    const a = new MongoMemory(db, { namespace: 'user:a' })
    const b = new MongoMemory(db, { namespace: 'user:b' })
    await a.rememberFact('k', 'va')
    await b.appendMessage({ role: 'user', content: 'for-b' })
    expect(await b.recallFacts()).toEqual({})
    expect(await a.loadHistory()).toEqual([])
  })
})

describe('composeMemory — short-term Redis-style + long-term Mongo', () => {
  it('keeps conversation in one store and facts in the other', async () => {
    const conversation = new InMemoryMemory() // stand-in for RedisMemory
    const facts = new MongoMemory(fakeDb(), { namespace: 'user:1' })
    const memory = composeMemory({ conversation, facts })

    const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'noted' }) }
    const agent = new Agent({ model, memory, rememberFacts: true })
    await agent.run('remember my name is Decimo')
    await memory.rememberFact?.('name', 'Decimo')

    expect((await conversation.loadHistory()).length).toBeGreaterThan(0) // transcript → conversation store
    expect(await facts.recallFacts()).toEqual({ name: 'Decimo' }) // facts → mongo store
  })
})
