import type { LoadHistoryOptions, Memory } from '@/memory/memory'
import { asJson, myQuery } from '@/mysql/schema'
import { type ResolvedTables, type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
import type { Message } from '@/shared/types'
/**
 * Layer 6 — Memory, backed by MySQL / MariaDB (via the `mysql2` driver).
 *
 * Conversation in `momo_messages` (ordered by `AUTO_INCREMENT` id), facts in
 * `momo_facts` — rename either via `tables`. `mysql2` is a type-only import — no
 * runtime dependency; pass a connected `Pool` (`mysql2/promise`).
 */
import type { Pool } from 'mysql2/promise'

/**
 * A MySQL / MariaDB-backed {@link Memory} for one scope.
 *
 * The tables must already exist — this class never creates them. Either call
 * `ensureSchema(pool)` once at boot, or apply `mysqlDdl()` via your migrations.
 * A missing table surfaces as a `SqlSchemaError` that says which one.
 *
 * ```ts
 * import { createPool } from 'mysql2/promise'
 * import { MySqlMemory, ensureSchema } from 'momo-agentic/mysql'
 *
 * const pool = createPool(process.env.MYSQL_URL!)
 * await ensureSchema(pool, { include: ['memory'] }) // optional — needs CREATE privilege
 * const agent = new Agent({ model, memory: new MySqlMemory(pool, `user:${userId}`) })
 * ```
 */
export class MySqlMemory implements Memory {
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
    const rows = options?.limit
      ? await myQuery(
          this.pool,
          table,
          `SELECT message FROM ${table} WHERE namespace=? ORDER BY id DESC LIMIT ?`,
          [this.namespace, options.limit],
        )
      : await myQuery(
          this.pool,
          table,
          `SELECT message FROM ${table} WHERE namespace=? ORDER BY id`,
          [this.namespace],
        )
    const list = rows.map((r) => asJson<Message>(r.message))
    return options?.limit ? list.reverse() : list
  }

  async appendMessage(message: Message): Promise<void> {
    const table = this.tables.messages
    await myQuery(this.pool, table, `INSERT INTO ${table} (namespace, message) VALUES (?, ?)`, [
      this.namespace,
      JSON.stringify(message),
    ])
  }

  async rememberFact(key: string, value: string): Promise<void> {
    const table = this.tables.facts
    await myQuery(
      this.pool,
      table,
      `INSERT INTO ${table} (namespace, \`key\`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const table = this.tables.facts
    const rows = await myQuery(
      this.pool,
      table,
      `SELECT \`key\`, value FROM ${table} WHERE namespace=?`,
      [this.namespace],
    )
    return Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]))
  }
}
