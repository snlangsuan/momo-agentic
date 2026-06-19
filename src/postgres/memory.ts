import type { LoadHistoryOptions, Memory } from '@/memory/memory'
import type { Message } from '@/shared/types'
/**
 * Layer 6 — Memory, backed by PostgreSQL (via the `pg` driver).
 *
 * Conversation lives in `momo_messages` (one row per turn, ordered by serial id),
 * facts in `momo_facts` (a row per `(namespace, key)`). `pg` is a type-only
 * import — no runtime dependency; pass a connected `Pool` in, and run
 * {@link ensureSchema} once to create the tables. Optional peer dependency.
 */
import type { Pool } from 'pg'

/**
 * A PostgreSQL-backed {@link Memory} for one scope (e.g. `user:u1` or
 * `chat:u1:t1`). Create one per conversation/user scope.
 *
 * ```ts
 * import { Pool } from 'pg'
 * import { PostgresMemory, ensureSchema } from 'momo-agentic/postgres'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * await ensureSchema(pool)
 * const agent = new Agent({ model, memory: new PostgresMemory(pool, `user:${userId}`) })
 * ```
 */
export class PostgresMemory implements Memory {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
  ) {}

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    if (options?.limit) {
      const { rows } = await this.pool.query(
        'SELECT message FROM momo_messages WHERE namespace=$1 ORDER BY id DESC LIMIT $2',
        [this.namespace, options.limit],
      )
      return rows.reverse().map((r) => r.message as Message)
    }
    const { rows } = await this.pool.query(
      'SELECT message FROM momo_messages WHERE namespace=$1 ORDER BY id',
      [this.namespace],
    )
    return rows.map((r) => r.message as Message)
  }

  async appendMessage(message: Message): Promise<void> {
    await this.pool.query('INSERT INTO momo_messages (namespace, message) VALUES ($1, $2)', [
      this.namespace,
      JSON.stringify(message),
    ])
  }

  async rememberFact(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO momo_facts (namespace, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query('SELECT key, value FROM momo_facts WHERE namespace=$1', [
      this.namespace,
    ])
    return Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]))
  }
}
