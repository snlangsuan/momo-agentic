import type { LoadHistoryOptions, Memory } from '@/memory/memory'
import { asJson } from '@/mysql/schema'
import type { Message } from '@/shared/types'
/**
 * Layer 6 — Memory, backed by MySQL / MariaDB (via the `mysql2` driver).
 *
 * Conversation in `momo_messages` (ordered by `AUTO_INCREMENT` id), facts in
 * `momo_facts`. `mysql2` is a type-only import — no runtime dependency; pass a
 * connected `Pool` (`mysql2/promise`) and run {@link ensureSchema} once.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise'

/**
 * A MySQL / MariaDB-backed {@link Memory} for one scope.
 *
 * ```ts
 * import { createPool } from 'mysql2/promise'
 * import { MySqlMemory, ensureSchema } from 'momo-agentic/mysql'
 *
 * const pool = createPool(process.env.MYSQL_URL!)
 * await ensureSchema(pool)
 * const agent = new Agent({ model, memory: new MySqlMemory(pool, `user:${userId}`) })
 * ```
 */
export class MySqlMemory implements Memory {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
  ) {}

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const [rows] = options?.limit
      ? await this.pool.query<RowDataPacket[]>(
          'SELECT message FROM momo_messages WHERE namespace=? ORDER BY id DESC LIMIT ?',
          [this.namespace, options.limit],
        )
      : await this.pool.query<RowDataPacket[]>(
          'SELECT message FROM momo_messages WHERE namespace=? ORDER BY id',
          [this.namespace],
        )
    const list = rows.map((r) => asJson<Message>(r.message))
    return options?.limit ? list.reverse() : list
  }

  async appendMessage(message: Message): Promise<void> {
    await this.pool.query('INSERT INTO momo_messages (namespace, message) VALUES (?, ?)', [
      this.namespace,
      JSON.stringify(message),
    ])
  }

  async rememberFact(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO momo_facts (namespace, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT `key`, value FROM momo_facts WHERE namespace=?',
      [this.namespace],
    )
    return Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]))
  }
}
