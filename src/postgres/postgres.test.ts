import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel } from '@/index'
import { PostgresModelCache } from '@/postgres/cache'
import { PostgresMemory } from '@/postgres/memory'
import { PostgresRunStore } from '@/postgres/run-store'
import { POSTGRES_DDL, checkSchema, ensureSchema, postgresDdl } from '@/postgres/schema'
import { SqlSchemaError } from '@/shared/sql-schema'
import type { Pool } from 'pg'

// --- a tiny in-process stand-in for the `pg` Pool ($1/$2 placeholders) ------
type Row = Record<string, unknown>

class FakePgPool {
  readonly ddl: string[] = []
  private msgs = new Map<string, unknown[]>()
  private facts = new Map<string, Map<string, string>>()
  private runs = new Map<string, unknown>()
  private cache = new Map<string, { response: unknown; expires: number }>()

  query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    return Promise.resolve({ rows: this.run(text.toLowerCase(), params) })
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

const fakePool = () => new FakePgPool() as unknown as Pool

describe('ensureSchema', () => {
  it('runs the CREATE TABLE statements', async () => {
    const pool = new FakePgPool()
    await ensureSchema(pool as unknown as Pool)
    expect(pool.ddl.length).toBeGreaterThanOrEqual(4)
    expect(pool.ddl.join('\n')).toContain('momo_messages')
  })

  it('creates only the included parts, under custom names', async () => {
    const pool = new FakePgPool()
    await ensureSchema(pool as unknown as Pool, {
      include: ['memory'],
      tables: { messages: 'bot.messages', facts: 'bot.facts' },
    })
    const sql = pool.ddl.join('\n')
    expect(pool.ddl).toHaveLength(3)
    expect(sql).toContain('bot.messages')
    expect(sql).toContain('idx_messages_ns_id on bot.messages')
    expect(sql).not.toContain('momo_run_checkpoints')
    expect(sql).not.toContain('momo_llm_cache')
  })

  it('explains the manual route when the DB user may not CREATE', async () => {
    const pool = { query: () => Promise.reject({ code: '42501' }) } as unknown as Pool
    const err = await ensureSchema(pool).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SqlSchemaError)
    expect((err as SqlSchemaError).table).toBe('momo_messages')
    expect((err as SqlSchemaError).message).toContain('postgresDdl()')
  })
})

describe('postgresDdl / checkSchema', () => {
  it('postgresDdl() equals POSTGRES_DDL and honors include', () => {
    expect(postgresDdl()).toEqual([...POSTGRES_DDL])
    expect(postgresDdl({ include: ['cache'] })).toHaveLength(1)
  })

  it('checkSchema only SELECTs and reports missing tables', async () => {
    const sent: string[] = []
    const pool = {
      query: (sql: string) => {
        sent.push(sql)
        return sql.includes('momo_facts') ? Promise.reject({ code: '42P01' }) : Promise.resolve({})
      },
    } as unknown as Pool
    expect(await checkSchema(pool, { include: ['memory'] })).toEqual({
      ok: false,
      missing: ['momo_facts'],
      denied: [],
    })
    expect(sent.every((s) => s.startsWith('SELECT'))).toBe(true)
  })
})

describe('missing tables at runtime', () => {
  it('surfaces a SqlSchemaError naming the table and the fix', async () => {
    const pool = { query: () => Promise.reject({ code: '42P01' }) } as unknown as Pool
    const err = await new PostgresMemory(pool, 'n').loadHistory().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SqlSchemaError)
    expect((err as SqlSchemaError).reason).toBe('missing_table')
    expect((err as SqlSchemaError).message).toContain('"momo_messages" does not exist')
  })

  it('uses custom table names in every backend', async () => {
    const sent: string[] = []
    const pool = {
      query: (sql: string) => {
        sent.push(sql)
        return Promise.resolve({ rows: [] })
      },
    } as unknown as Pool
    const tables = { messages: 'm1', facts: 'f1', runCheckpoints: 'r1', llmCache: 'c1' }
    const memory = new PostgresMemory(pool, 'n', { tables })
    await memory.appendMessage({ role: 'user', content: 'a' })
    await memory.recallFacts()
    await new PostgresRunStore(pool, { tables }).load('x')
    await new PostgresModelCache(pool, { tables }).get('k')
    expect(sent.join('\n')).not.toContain('momo_')
    for (const t of Object.values(tables)) expect(sent.join('\n')).toContain(` ${t} `)
  })

  it('rejects unsafe table names up front', () => {
    expect(() => new PostgresMemory(fakePool(), 'n', { tables: { messages: 'x;--' } })).toThrow(
      TypeError,
    )
  })
})

describe('PostgresMemory', () => {
  it('appends and loads conversation in order', async () => {
    const m = new PostgresMemory(fakePool(), 'chat:u1:t1')
    await m.appendMessage({ role: 'user', content: 'a' })
    await m.appendMessage({ role: 'assistant', content: 'b' })
    expect((await m.loadHistory()).map((x) => x.content)).toEqual(['a', 'b'])
  })

  it('honors a limit (most recent N, oldest → newest)', async () => {
    const m = new PostgresMemory(fakePool(), 'n')
    for (const c of ['a', 'b', 'c']) await m.appendMessage({ role: 'user', content: c })
    expect((await m.loadHistory({ limit: 2 })).map((x) => x.content)).toEqual(['b', 'c'])
  })

  it('upserts and recalls facts', async () => {
    const m = new PostgresMemory(fakePool(), 'user:1')
    await m.rememberFact('name', 'Decimo')
    await m.rememberFact('name', 'Decimo II') // upsert
    await m.rememberFact('city', 'Bangkok')
    expect(await m.recallFacts()).toEqual({ name: 'Decimo II', city: 'Bangkok' })
  })

  it('persists an Agent turn end-to-end', async () => {
    const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'hi' }) }
    const memory = new PostgresMemory(fakePool(), 'agent')
    await new Agent({ model, memory }).run('hello')
    expect((await memory.loadHistory()).map((x) => `${x.role}:${x.content}`)).toEqual([
      'user:hello',
      'assistant:hi',
    ])
  })
})

describe('PostgresRunStore', () => {
  it('saves, loads, and deletes a checkpoint', async () => {
    const store = new PostgresRunStore(fakePool())
    const cp = {
      runId: 'r1',
      input: 'hi',
      messages: [{ role: 'user' as const, content: 'hi' }],
      step: 1,
      toolsInvoked: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      status: 'running' as const,
    }
    await store.save(cp)
    expect(await store.load('r1')).toEqual(cp)
    await store.delete('r1')
    expect(await store.load('r1')).toBeUndefined()
  })
})

describe('PostgresModelCache', () => {
  it('round-trips a response, honoring expiry', async () => {
    const cache = new PostgresModelCache(fakePool(), { ttlSeconds: 60 })
    expect(await cache.get('k')).toBeUndefined()
    await cache.set('k', { content: 'cached' })
    expect(await cache.get('k')).toEqual({ content: 'cached' })
  })
})
