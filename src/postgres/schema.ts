import {
  type SqlSchemaOptions,
  type SqlSchemaReport,
  bareName,
  explainCreateError,
  explainQueryError,
  probeTables,
  resolveTables,
  selectedParts,
  tablesFor,
} from '@/shared/sql-schema'
/**
 * DDL for the PostgreSQL backends. `pg` is a type-only import (no runtime
 * dependency) — pass a connected `Pool` in.
 *
 * Creating the tables is up to you: call {@link ensureSchema} at boot if the DB
 * user may CREATE TABLE, or apply {@link postgresDdl} through your own migrations
 * / a DBA and verify with {@link checkSchema}. The backends never create tables
 * on their own.
 */
import type { Pool, QueryResult } from 'pg'

/**
 * The idempotent `CREATE TABLE IF NOT EXISTS` statements for the selected table
 * groups and names — hand them to a migration tool or a DBA when the app's DB
 * user can't create tables.
 *
 * ```ts
 * console.log(postgresDdl({ include: ['memory'] }).join(';\n\n') + ';')
 * ```
 */
export function postgresDdl(options: SqlSchemaOptions = {}): string[] {
  const t = resolveTables(options.tables)
  const ddl: string[] = []
  for (const part of selectedParts(options.include)) {
    if (part === 'memory') {
      ddl.push(
        `CREATE TABLE IF NOT EXISTS ${t.messages} (
    id         BIGSERIAL PRIMARY KEY,
    namespace  TEXT        NOT NULL,
    message    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
        `CREATE INDEX IF NOT EXISTS idx_${bareName(t.messages)}_ns_id ON ${t.messages} (namespace, id)`,
        `CREATE TABLE IF NOT EXISTS ${t.facts} (
    namespace TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  )`,
      )
    } else if (part === 'runStore') {
      ddl.push(`CREATE TABLE IF NOT EXISTS ${t.runCheckpoints} (
    run_id     TEXT PRIMARY KEY,
    checkpoint JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
    } else {
      ddl.push(`CREATE TABLE IF NOT EXISTS ${t.llmCache} (
    cache_key  TEXT PRIMARY KEY,
    response   JSONB       NOT NULL,
    expires_at TIMESTAMPTZ
  )`)
    }
  }
  return ddl
}

/** Every default `momo_*` table/index statement (same as `postgresDdl()`). */
export const POSTGRES_DDL: readonly string[] = postgresDdl()

/**
 * Opt-in: create the momo-agentic tables/indexes if they don't exist (run once at
 * boot). Needs CREATE privilege — if the DB user lacks it this throws a
 * `SqlSchemaError` explaining the manual route ({@link postgresDdl} +
 * {@link checkSchema}).
 *
 * ```ts
 * await ensureSchema(pool)                                  // all tables
 * await ensureSchema(pool, { include: ['memory'] })         // only what you use
 * await ensureSchema(pool, { tables: { messages: 'bot.messages' } })
 * ```
 */
export async function ensureSchema(pool: Pool, options: SqlSchemaOptions = {}): Promise<void> {
  for (const statement of postgresDdl(options)) {
    try {
      await pool.query(statement)
    } catch (err) {
      const table = statement.match(/ (?:EXISTS|ON) (\S+) \(/)?.[1] ?? ''
      throw explainCreateError(err, table, 'postgres')
    }
  }
}

/**
 * Read-only check that the tables exist and are readable — never creates anything.
 * Use it at boot instead of {@link ensureSchema} when tables are managed by
 * migrations / a DBA, to fail fast with a clear list rather than on the first turn.
 *
 * ```ts
 * const report = await checkSchema(pool, { include: ['memory'] })
 * if (!report.ok) throw new Error(`missing tables: ${report.missing.join(', ')}`)
 * ```
 */
export function checkSchema(pool: Pool, options: SqlSchemaOptions = {}): Promise<SqlSchemaReport> {
  return probeTables(tablesFor(options), (sql) => pool.query(sql))
}

/** Run a query against `table`, turning missing-table/privilege errors into a `SqlSchemaError`. */
export async function pgQuery(
  pool: Pool,
  table: string,
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  try {
    return await pool.query(sql, params)
  } catch (err) {
    throw explainQueryError(err, table, 'postgres')
  }
}
