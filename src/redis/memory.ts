/**
 * Layer 6 — Memory, backed by Redis (via `ioredis`).
 *
 * Short-term conversation lives in a Redis list, long-term facts in a hash, both
 * namespaced per scope (`<namespace>:messages` / `<namespace>:facts`). `ioredis`
 * is a type-only import — this module pulls in NO runtime dependency; you pass a
 * connected client in. It is an optional peer dependency: install it only if you
 * import `momo-agentic/redis`.
 */
import type { Redis } from 'ioredis'
import type { LoadHistoryOptions, Memory } from '../memory/memory'
import type { Message } from '../shared/types'

/** Options for {@link RedisMemory}. */
export interface RedisMemoryOptions {
  /** Key namespace for this scope, e.g. `chat:u1:t1` (one per user/thread). */
  namespace: string
  /** Optional expiry (seconds), refreshed on every write — a sliding TTL. */
  ttlSeconds?: number
}

/**
 * A Redis-backed {@link Memory}: conversation history (a list) plus durable facts
 * (a hash). Create one per conversation scope:
 *
 * ```ts
 * import Redis from 'ioredis'
 * import { RedisMemory } from 'momo-agentic/redis'
 *
 * const redis = new Redis(process.env.REDIS_URL)
 * const memory = new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 })
 * const agent = new Agent({ model, memory })
 * ```
 */
export class RedisMemory implements Memory {
  private readonly messagesKey: string
  private readonly factsKey: string
  private readonly ttlSeconds?: number

  constructor(
    private readonly redis: Redis,
    options: RedisMemoryOptions,
  ) {
    this.messagesKey = `${options.namespace}:messages`
    this.factsKey = `${options.namespace}:facts`
    this.ttlSeconds = options.ttlSeconds
  }

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const start = options?.limit ? -options.limit : 0
    const raw = await this.redis.lrange(this.messagesKey, start, -1)
    return raw.map((entry) => JSON.parse(entry) as Message)
  }

  async appendMessage(message: Message): Promise<void> {
    await this.redis.rpush(this.messagesKey, JSON.stringify(message))
    await this.touch(this.messagesKey)
  }

  async rememberFact(key: string, value: string): Promise<void> {
    await this.redis.hset(this.factsKey, key, value)
    await this.touch(this.factsKey)
  }

  async recallFacts(): Promise<Record<string, string>> {
    return this.redis.hgetall(this.factsKey)
  }

  private async touch(key: string): Promise<void> {
    if (this.ttlSeconds && this.ttlSeconds > 0) await this.redis.expire(key, this.ttlSeconds)
  }
}
