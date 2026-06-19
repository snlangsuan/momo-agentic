import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel } from '@/index'
import { RedisModelCache } from '@/redis/cache'
import { RedisMemory } from '@/redis/memory'
import { RedisRunStore } from '@/redis/run-store'
import type { Redis } from 'ioredis'

/** A tiny in-process stand-in for the `ioredis` commands these classes use. */
class FakeRedis {
  readonly data = new Map<string, unknown>()

  get(key: string): Promise<string | null> {
    return Promise.resolve((this.data.get(key) as string | undefined) ?? null)
  }
  set(key: string, value: string): Promise<'OK'> {
    this.data.set(key, value)
    return Promise.resolve('OK')
  }
  del(key: string): Promise<number> {
    return Promise.resolve(this.data.delete(key) ? 1 : 0)
  }
  expire(): Promise<number> {
    return Promise.resolve(1)
  }
  rpush(key: string, ...values: string[]): Promise<number> {
    const list = (this.data.get(key) as string[] | undefined) ?? []
    list.push(...values)
    this.data.set(key, list)
    return Promise.resolve(list.length)
  }
  lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = (this.data.get(key) as string[] | undefined) ?? []
    const s = start < 0 ? Math.max(list.length + start, 0) : start
    const e = stop < 0 ? list.length + stop : stop
    return Promise.resolve(list.slice(s, e + 1))
  }
  hset(key: string, field: string, value: string): Promise<number> {
    const hash = (this.data.get(key) as Record<string, string> | undefined) ?? {}
    hash[field] = value
    this.data.set(key, hash)
    return Promise.resolve(1)
  }
  hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve((this.data.get(key) as Record<string, string> | undefined) ?? {})
  }
}

const fakeRedis = () => new FakeRedis() as unknown as Redis

describe('RedisMemory', () => {
  it('appends and loads conversation messages in order', async () => {
    const memory = new RedisMemory(fakeRedis(), { namespace: 'chat:u1:t1' })
    await memory.appendMessage({ role: 'user', content: 'a' })
    await memory.appendMessage({ role: 'assistant', content: 'b' })
    expect((await memory.loadHistory()).map((m) => m.content)).toEqual(['a', 'b'])
  })

  it('honors a limit (most recent N)', async () => {
    const memory = new RedisMemory(fakeRedis(), { namespace: 'n' })
    for (const c of ['a', 'b', 'c']) await memory.appendMessage({ role: 'user', content: c })
    expect((await memory.loadHistory({ limit: 2 })).map((m) => m.content)).toEqual(['b', 'c'])
  })

  it('stores and recalls durable facts', async () => {
    const memory = new RedisMemory(fakeRedis(), { namespace: 'n' })
    await memory.rememberFact?.('name', 'Somchai')
    await memory.rememberFact?.('city', 'Bangkok')
    expect(await memory.recallFacts?.()).toEqual({ name: 'Somchai', city: 'Bangkok' })
  })

  it('isolates scopes by namespace', async () => {
    const redis = fakeRedis()
    const a = new RedisMemory(redis, { namespace: 'u:a' })
    const b = new RedisMemory(redis, { namespace: 'u:b' })
    await a.appendMessage({ role: 'user', content: 'for-a' })
    expect(await b.loadHistory()).toEqual([])
  })

  it('persists an Agent turn end-to-end', async () => {
    const model: LanguageModel = {
      id: 'm',
      generate: () => Promise.resolve({ content: 'hi there' }),
    }
    const memory = new RedisMemory(fakeRedis(), { namespace: 'agent' })
    await new Agent({ model, memory }).run('hello')
    expect((await memory.loadHistory()).map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:hi there',
    ])
  })
})

describe('RedisModelCache', () => {
  it('round-trips a response and prefixes the key', async () => {
    const redis = fakeRedis()
    const cache = new RedisModelCache(redis, { keyPrefix: 'p:' })
    expect(await cache.get('k')).toBeUndefined()
    await cache.set('k', { content: 'cached', usage: { inputTokens: 1, outputTokens: 2 } })
    expect(await cache.get('k')).toEqual({
      content: 'cached',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect((redis as unknown as FakeRedis).data.has('p:k')).toBe(true)
  })
})

describe('RedisRunStore', () => {
  it('saves, loads, and deletes a checkpoint', async () => {
    const store = new RedisRunStore(fakeRedis())
    const checkpoint = {
      runId: 'r1',
      input: 'hi',
      messages: [{ role: 'user' as const, content: 'hi' }],
      step: 2,
      toolsInvoked: ['t'],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      status: 'running' as const,
    }
    await store.save(checkpoint)
    expect(await store.load('r1')).toEqual(checkpoint)
    await store.delete('r1')
    expect(await store.load('r1')).toBeUndefined()
  })
})
