import type { ModelCache } from '@/cognition/cache'
import type { ModelResponse } from '@/cognition/model'
import { pgQuery } from '@/postgres/schema'
import { type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
/**
 * Layer 5/8 — a PostgreSQL-backed {@link ModelCache} for `cacheModel` (via `pg`).
 *
 * Shares an LLM response cache (with a TTL) in `momo_llm_cache` (rename via
 * `tables`). `pg` is a type-only import.
 */
import type { Pool } from 'pg'

/** Options for {@link PostgresModelCache}. */
export interface PostgresModelCacheOptions extends SqlTableOptions {
  /** Entry TTL in seconds. Defaults to 3600; set 0 for no expiry. */
  ttlSeconds?: number
}

/**
 * A PostgreSQL-backed {@link ModelCache}. The table must already exist — create it
 * with `ensureSchema(pool, { include: ['cache'] })` or apply `postgresDdl()`.
 */
export class PostgresModelCache implements ModelCache {
  private readonly ttlSeconds: number
  private readonly table: string

  constructor(
    private readonly pool: Pool,
    options: PostgresModelCacheOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 3600
    this.table = resolveTables(options.tables).llmCache
  }

  async get(key: string): Promise<ModelResponse | undefined> {
    const { rows } = await pgQuery(
      this.pool,
      this.table,
      `SELECT response FROM ${this.table} WHERE cache_key=$1 AND (expires_at IS NULL OR expires_at > now())`,
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
    await pgQuery(
      this.pool,
      this.table,
      `INSERT INTO ${this.table} (cache_key, response, expires_at) VALUES ($1, $2, ${expires})
       ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
      params,
    )
  }
}
