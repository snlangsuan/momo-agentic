/**
 * Layer 5/8 — a PostgreSQL-backed {@link ModelCache} for `cacheModel` (via `pg`).
 *
 * Shares an LLM response cache (with a TTL) in `momo_llm_cache`. `pg` is a
 * type-only import.
 */
import type { Pool } from 'pg'
import type { ModelCache } from '../cognition/cache'
import type { ModelResponse } from '../cognition/model'

/** Options for {@link PostgresModelCache}. */
export interface PostgresModelCacheOptions {
  /** Entry TTL in seconds. Defaults to 3600; set 0 for no expiry. */
  ttlSeconds?: number
}

/** A PostgreSQL-backed {@link ModelCache}. Run {@link ensureSchema} once to create the table. */
export class PostgresModelCache implements ModelCache {
  private readonly ttlSeconds: number

  constructor(
    private readonly pool: Pool,
    options: PostgresModelCacheOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 3600
  }

  async get(key: string): Promise<ModelResponse | undefined> {
    const { rows } = await this.pool.query(
      'SELECT response FROM momo_llm_cache WHERE cache_key=$1 AND (expires_at IS NULL OR expires_at > now())',
      [key],
    )
    return rows[0]?.response as ModelResponse | undefined
  }

  async set(key: string, value: ModelResponse): Promise<void> {
    const expires = this.ttlSeconds > 0 ? `now() + ($3 || ' seconds')::interval` : 'NULL'
    const params =
      this.ttlSeconds > 0
        ? [key, JSON.stringify(value), this.ttlSeconds]
        : [key, JSON.stringify(value)]
    await this.pool.query(
      `INSERT INTO momo_llm_cache (cache_key, response, expires_at) VALUES ($1, $2, ${expires})
       ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
      params,
    )
  }
}
