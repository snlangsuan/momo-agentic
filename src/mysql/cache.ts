/**
 * Layer 5/8 — a MySQL / MariaDB-backed {@link ModelCache} for `cacheModel`
 * (via `mysql2`). Shares an LLM response cache (with TTL) in `momo_llm_cache`.
 * `mysql2` is a type-only import.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ModelCache } from '../cognition/cache'
import type { ModelResponse } from '../cognition/model'
import { asJson } from './schema'

/** Options for {@link MySqlModelCache}. */
export interface MySqlModelCacheOptions {
  /** Entry TTL in seconds. Defaults to 3600; set 0 for no expiry. */
  ttlSeconds?: number
}

/**
 * A MySQL / MariaDB-backed {@link ModelCache}. Run {@link ensureSchema} once.
 * Rows don't auto-expire — schedule `DELETE FROM momo_llm_cache WHERE expires_at < NOW()`.
 */
export class MySqlModelCache implements ModelCache {
  private readonly ttlSeconds: number

  constructor(
    private readonly pool: Pool,
    options: MySqlModelCacheOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 3600
  }

  async get(key: string): Promise<ModelResponse | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT response FROM momo_llm_cache WHERE cache_key=? AND (expires_at IS NULL OR expires_at > NOW())',
      [key],
    )
    return rows[0] ? asJson<ModelResponse>(rows[0].response) : undefined
  }

  async set(key: string, value: ModelResponse): Promise<void> {
    if (this.ttlSeconds > 0) {
      await this.pool.query(
        `INSERT INTO momo_llm_cache (cache_key, response, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
         ON DUPLICATE KEY UPDATE response = VALUES(response), expires_at = VALUES(expires_at)`,
        [key, JSON.stringify(value), this.ttlSeconds],
      )
    } else {
      await this.pool.query(
        `INSERT INTO momo_llm_cache (cache_key, response, expires_at) VALUES (?, ?, NULL)
         ON DUPLICATE KEY UPDATE response = VALUES(response), expires_at = NULL`,
        [key, JSON.stringify(value)],
      )
    }
  }
}
