/**
 * Layer 5/8 — a Redis-backed {@link ModelCache} for `cacheModel` (via `ioredis`).
 *
 * Shares an LLM response cache across instances/restarts, with a TTL. `ioredis`
 * is a type-only import (no runtime dependency); pass a connected client in.
 */
import type { Redis } from 'ioredis'
import type { ModelCache } from '../cognition/cache'
import type { ModelResponse } from '../cognition/model'

/** Options for {@link RedisModelCache}. */
export interface RedisModelCacheOptions {
  /** Key prefix. Defaults to `"momo:llm:"`. */
  keyPrefix?: string
  /** Entry TTL in seconds. Defaults to 3600; set 0 for no expiry. */
  ttlSeconds?: number
}

/**
 * A Redis-backed {@link ModelCache}. Pair with `cacheModel`; hash the key
 * (the default cache key is the full transcript JSON) to keep Redis keys short:
 *
 * ```ts
 * import { createHash } from 'node:crypto'
 * import { cacheModel } from 'momo-agentic'
 * import { RedisModelCache } from 'momo-agentic/redis'
 *
 * const model = cacheModel(provider, {
 *   cache: new RedisModelCache(redis, { ttlSeconds: 3600 }),
 *   key: (m, o) => createHash('sha256').update(JSON.stringify({ id: m.id, ...o })).digest('hex'),
 * })
 * ```
 */
export class RedisModelCache implements ModelCache {
  private readonly prefix: string
  private readonly ttlSeconds: number

  constructor(
    private readonly redis: Redis,
    options: RedisModelCacheOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? 'momo:llm:'
    this.ttlSeconds = options.ttlSeconds ?? 3600
  }

  async get(key: string): Promise<ModelResponse | undefined> {
    const raw = await this.redis.get(this.prefix + key)
    return raw ? (JSON.parse(raw) as ModelResponse) : undefined
  }

  async set(key: string, value: ModelResponse): Promise<void> {
    const fullKey = this.prefix + key
    const payload = JSON.stringify(value)
    if (this.ttlSeconds > 0) await this.redis.set(fullKey, payload, 'EX', this.ttlSeconds)
    else await this.redis.set(fullKey, payload)
  }
}
