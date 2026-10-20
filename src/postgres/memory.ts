import type { LoadHistoryOptions, Memory } from '@/memory/memory'
import { pgQuery } from '@/postgres/schema'
import { type ResolvedTables, type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
import type { Message } from '@/shared/types'
/**
 * Layer 6 — Memory, backed by PostgreSQL (via the `pg` driver).
 *
 * Conversation lives in `momo_messages` (one row per turn, ordered by serial id),
 * facts in `momo_facts` (a row per `(namespace, key)`) — rename either via
 * `tables`. `pg` is a type-only import — no runtime dependency; pass a connected
 * `Pool` in. Optional peer dependency.
 */
import type { Pool } from 'pg'

/**
 * A PostgreSQL-backed {@link Memory} for one scope (e.g. `user:u1` or
 * `chat:u1:t1`). Create one per conversation/user scope.
 *
 * The tables must already exist — this class never creates them. Either call
 * `ensureSchema(pool)` once at boot, or apply `postgresDdl()` via your migrations.
 * A missing table surfaces as a `SqlSchemaError` that says which one.
 *
 * ```ts
 * import { Pool } from 'pg'
 * import { PostgresMemory, ensureSchema } from 'momo-agentic/postgres'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * await ensureSchema(pool, { include: ['memory'] }) // optional — needs CREATE privilege
 * const agent = new Agent({ model, memory: new PostgresMemory(pool, `user:${userId}`) })
 * ```
 */
export class PostgresMemory implements Memory {
  private readonly tables: ResolvedTables

  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
    options: SqlTableOptions = {},
  ) {
    this.tables = resolveTables(options.tables)
  }

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const table = this.tables.messages
    if (options?.limit) {
      const { rows } = await pgQuery(
        this.pool,
        table,
        `SELECT message FROM ${table} WHERE namespace=$1 ORDER BY id DESC LIMIT $2`,
        [this.namespace, options.limit],
      )
      return rows.reverse().map((r) => r.message as Message)
    }
    const { rows } = await pgQuery(
      this.pool,
      table,
      `SELECT message FROM ${table} WHERE namespace=$1 ORDER BY id`,
      [this.namespace],
    )
    return rows.map((r) => r.message as Message)
  }

  async appendMessage(message: Message): Promise<void> {
    const table = this.tables.messages
    await pgQuery(this.pool, table, `INSERT INTO ${table} (namespace, message) VALUES ($1, $2)`, [
      this.namespace,
      JSON.stringify(message),
    ])
  }

  async rememberFact(key: string, value: string): Promise<void> {
    const table = this.tables.facts
    await pgQuery(
      this.pool,
      table,
      `INSERT INTO ${table} (namespace, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const table = this.tables.facts
    const { rows } = await pgQuery(
      this.pool,
      table,
      `SELECT key, value FROM ${table} WHERE namespace=$1`,
      [this.namespace],
    )
    return Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]))
  }
}
