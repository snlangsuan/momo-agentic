import type { ModelCache } from '@/cognition/cache'
import type { ModelResponse } from '@/cognition/model'
import { asJson, myQuery } from '@/mysql/schema'
import { type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
/**
 * Layer 5/8 — a MySQL / MariaDB-backed {@link ModelCache} for `cacheModel`
 * (via `mysql2`). Shares an LLM response cache (with TTL) in `momo_llm_cache`
 * (rename via `tables`). `mysql2` is a type-only import.
 */
import type { Pool } from 'mysql2/promise'

/** Options for {@link MySqlModelCache}. */
export interface MySqlModelCacheOptions extends SqlTableOptions {
  /** Entry TTL in seconds. Defaults to 3600; set 0 for no expiry. */
  ttlSeconds?: number
}

/**
 * A MySQL / MariaDB-backed {@link ModelCache}. The table must already exist —
 * create it with `ensureSchema(pool, { include: ['cache'] })` or apply `mysqlDdl()`.
 * Rows don't auto-expire — schedule `DELETE FROM momo_llm_cache WHERE expires_at < NOW()`.
 */
export class MySqlModelCache implements ModelCache {
  private readonly ttlSeconds: number
  private readonly table: string

  constructor(
    private readonly pool: Pool,
    options: MySqlModelCacheOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 3600
    this.table = resolveTables(options.tables).llmCache
  }

  async get(key: string): Promise<ModelResponse | undefined> {
    const rows = await myQuery(
      this.pool,
      this.table,
      `SELECT response FROM ${this.table} WHERE cache_key=? AND (expires_at IS NULL OR expires_at > NOW())`,
      [key],
    )
    return rows[0] ? asJson<ModelResponse>(rows[0].response) : undefined
  }

  async set(key: string, value: ModelResponse): Promise<void> {
    if (this.ttlSeconds > 0) {
      await myQuery(
        this.pool,
        this.table,
        `INSERT INTO ${this.table} (cache_key, response, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
         ON DUPLICATE KEY UPDATE response = VALUES(response), expires_at = VALUES(expires_at)`,
        [key, JSON.stringify(value), this.ttlSeconds],
      )
    } else {
      await myQuery(
        this.pool,
        this.table,
        `INSERT INTO ${this.table} (cache_key, response, expires_at) VALUES (?, ?, NULL)
         ON DUPLICATE KEY UPDATE response = VALUES(response), expires_at = NULL`,
        [key, JSON.stringify(value)],
      )
    }
  }
}
