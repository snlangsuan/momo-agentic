import { describe, expect, it } from 'bun:test'
import {
  SqlSchemaError,
  classifySqlError,
  explainCreateError,
  explainQueryError,
  probeTables,
  resolveTables,
  tablesFor,
} from '@/shared/sql-schema'

describe('resolveTables', () => {
  it('defaults to the momo_* names and applies overrides', () => {
    expect(resolveTables()).toEqual({
      messages: 'momo_messages',
      facts: 'momo_facts',
      runCheckpoints: 'momo_run_checkpoints',
      llmCache: 'momo_llm_cache',
    })
    expect(resolveTables({ messages: 'app.bot_messages' }).messages).toBe('app.bot_messages')
  })

  it('rejects names that are not plain (optionally schema-qualified) identifiers', () => {
    expect(() => resolveTables({ facts: 'x; DROP TABLE users' })).toThrow(TypeError)
    expect(() => resolveTables({ facts: 'a.b.c' })).toThrow(TypeError)
    expect(() => resolveTables({ facts: '1abc' })).toThrow(TypeError)
  })
})

describe('tablesFor', () => {
  it('lists only the tables of the included parts', () => {
    expect(tablesFor()).toHaveLength(4)
    expect(tablesFor({ include: ['memory'] })).toEqual(['momo_messages', 'momo_facts'])
    expect(tablesFor({ include: ['cache'], tables: { llmCache: 'c' } })).toEqual(['c'])
  })
})

describe('classifySqlError', () => {
  it('recognizes pg and mysql2 missing-table / privilege errors', () => {
    expect(classifySqlError({ code: '42P01' })).toBe('missing_table')
    expect(classifySqlError({ code: 'ER_NO_SUCH_TABLE', errno: 1146 })).toBe('missing_table')
    expect(classifySqlError({ code: '42501' })).toBe('permission_denied')
    expect(classifySqlError({ errno: 1142 })).toBe('permission_denied')
    expect(classifySqlError(new Error('boom'))).toBeUndefined()
    expect(classifySqlError(undefined)).toBeUndefined()
  })
})

describe('explain*Error', () => {
  it('turns a missing table into an actionable SqlSchemaError (cause kept)', () => {
    const cause = { code: '42P01' }
    const err = explainQueryError(cause, 'momo_messages', 'postgres') as SqlSchemaError
    expect(err).toBeInstanceOf(SqlSchemaError)
    expect(err.reason).toBe('missing_table')
    expect(err.table).toBe('momo_messages')
    expect(err.cause).toBe(cause)
    expect(err.message).toContain('ensureSchema')
    expect(err.message).toContain('postgresDdl()')
  })

  it('points a no-CREATE user at the manual route', () => {
    const err = explainCreateError({ errno: 1142 }, 'momo_facts', 'mysql') as SqlSchemaError
    expect(err.reason).toBe('permission_denied')
    expect(err.message).toContain('mysqlDdl()')
    expect(err.message).toContain('checkSchema')
  })

  it('passes unrelated errors through untouched', () => {
    const other = new Error('connection refused')
    expect(explainQueryError(other, 't', 'postgres')).toBe(other)
    expect(explainCreateError({ code: '42P01' }, 't', 'postgres')).toEqual({ code: '42P01' })
  })
})

describe('probeTables', () => {
  it('reports missing and unreadable tables without creating anything', async () => {
    const seen: string[] = []
    const report = await probeTables(['a', 'b', 'c'], async (sql) => {
      seen.push(sql)
      if (sql.includes(' b ')) throw { code: '42P01' }
      if (sql.includes(' c ')) throw { code: '42501' }
    })
    expect(report).toEqual({ ok: false, missing: ['b'], denied: ['c'] })
    expect(seen.every((s) => s.startsWith('SELECT 1 FROM'))).toBe(true)
  })

  it('rethrows errors that are not about the schema', async () => {
    const boom = new Error('connection refused')
    await expect(
      probeTables(['a'], () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })
})
