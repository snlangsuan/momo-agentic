import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel } from '@/index'
import { MySqlModelCache } from '@/mysql/cache'
import { MySqlMemory } from '@/mysql/memory'
import { MySqlRunStore } from '@/mysql/run-store'
import { asJson, ensureSchema } from '@/mysql/schema'
import type { Pool } from 'mysql2/promise'

// --- a tiny in-process stand-in for the mysql2 Pool (? placeholders) --------
type Row = Record<string, unknown>

class FakeMyPool {
  readonly ddl: string[] = []
  private msgs = new Map<string, unknown[]>()
  private facts = new Map<string, Map<string, string>>()
  private runs = new Map<string, unknown>()
  private cache = new Map<string, { response: unknown; expires: number }>()

  // mysql2 returns [rows, fields]
  query(sql: string, params: unknown[] = []): Promise<[Row[], unknown[]]> {
    return Promise.resolve([this.run(sql.toLowerCase(), params), []])
  }

  private run(s: string, p: unknown[]): Row[] {
    const verb = s.split(' ', 1)[0]
    if (verb === 'create') {
      this.ddl.push(s)
      return []
    }
    if (verb === 'delete') {
      this.runs.delete(p[0] as string)
      return []
    }
    if (verb === 'insert') return this.insert(s, p)
    return this.select(s, p)
  }

  private insert(s: string, p: unknown[]): Row[] {
    if (s.includes('momo_messages')) {
      const list = this.msgs.get(p[0] as string) ?? []
      list.push(JSON.parse(p[1] as string))
      this.msgs.set(p[0] as string, list)
    } else if (s.includes('momo_facts')) {
      const m = this.facts.get(p[0] as string) ?? new Map<string, string>()
      m.set(p[1] as string, p[2] as string)
      this.facts.set(p[0] as string, m)
    } else if (s.includes('momo_run_checkpoints')) {
      this.runs.set(p[0] as string, JSON.parse(p[1] as string))
    } else if (s.includes('momo_llm_cache')) {
      const ttl = p[2] as number | undefined
      this.cache.set(p[0] as string, {
        response: JSON.parse(p[1] as string),
        expires: ttl ? Date.now() + ttl * 1000 : 0,
      })
    }
    return []
  }

  private select(s: string, p: unknown[]): Row[] {
    if (s.includes('momo_messages')) {
      const list = this.msgs.get(p[0] as string) ?? []
      const rows = s.includes('limit') ? list.slice(-(p[1] as number)).reverse() : list
      return rows.map((m) => ({ message: m }))
    }
    if (s.includes('momo_facts')) {
      const m = this.facts.get(p[0] as string) ?? new Map<string, string>()
      return [...m.entries()].map(([key, value]) => ({ key, value }))
    }
    if (s.includes('momo_run_checkpoints')) {
      const cp = this.runs.get(p[0] as string)
      return cp ? [{ checkpoint: cp }] : []
    }
    const e = this.cache.get(p[0] as string)
    return e && (!e.expires || e.expires > Date.now()) ? [{ response: e.response }] : []
  }
}

const fakePool = () => new FakeMyPool() as unknown as Pool

describe('asJson (MySQL parsed vs MariaDB string)', () => {
  it('parses a JSON string and passes a parsed object through', () => {
    expect(asJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(asJson<{ a: number }>({ a: 1 })).toEqual({ a: 1 })
  })
})

describe('ensureSchema', () => {
  it('runs the CREATE TABLE statements', async () => {
    const pool = new FakeMyPool()
    await ensureSchema(pool as unknown as Pool)
    expect(pool.ddl.length).toBeGreaterThanOrEqual(4)
    expect(pool.ddl.join('\n')).toContain('momo_messages')
  })
})

describe('MySqlMemory', () => {
  it('appends and loads conversation in order', async () => {
    const m = new MySqlMemory(fakePool(), 'chat:u1:t1')
    await m.appendMessage({ role: 'user', content: 'a' })
    await m.appendMessage({ role: 'assistant', content: 'b' })
    expect((await m.loadHistory()).map((x) => x.content)).toEqual(['a', 'b'])
  })

  it('honors a limit (most recent N, oldest → newest)', async () => {
    const m = new MySqlMemory(fakePool(), 'n')
    for (const c of ['a', 'b', 'c']) await m.appendMessage({ role: 'user', content: c })
    expect((await m.loadHistory({ limit: 2 })).map((x) => x.content)).toEqual(['b', 'c'])
  })

  it('upserts and recalls facts', async () => {
    const m = new MySqlMemory(fakePool(), 'user:1')
    await m.rememberFact('name', 'Decimo')
    await m.rememberFact('city', 'Bangkok')
    expect(await m.recallFacts()).toEqual({ name: 'Decimo', city: 'Bangkok' })
  })

  it('persists an Agent turn end-to-end', async () => {
    const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'hi' }) }
    const memory = new MySqlMemory(fakePool(), 'agent')
    await new Agent({ model, memory }).run('hello')
    expect((await memory.loadHistory()).map((x) => x.content)).toEqual(['hello', 'hi'])
  })
})

describe('MySqlRunStore + MySqlModelCache', () => {
  it('run store saves/loads/deletes', async () => {
    const store = new MySqlRunStore(fakePool())
    const cp = {
      runId: 'r1',
      input: 'hi',
      messages: [],
      step: 1,
      toolsInvoked: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      status: 'running' as const,
    }
    await store.save(cp)
    expect((await store.load('r1'))?.runId).toBe('r1')
    await store.delete('r1')
    expect(await store.load('r1')).toBeUndefined()
  })

  it('cache round-trips with and without TTL', async () => {
    const ttl = new MySqlModelCache(fakePool(), { ttlSeconds: 60 })
    await ttl.set('k', { content: 'x' })
    expect(await ttl.get('k')).toEqual({ content: 'x' })

    const noTtl = new MySqlModelCache(fakePool(), { ttlSeconds: 0 })
    await noTtl.set('k', { content: 'y' })
    expect(await noTtl.get('k')).toEqual({ content: 'y' })
  })
})
