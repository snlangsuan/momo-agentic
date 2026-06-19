/**
 * Layer 8 — a Redis-backed {@link RunStore} for durable runs (via `ioredis`).
 *
 * Persists run checkpoints in Redis so a run can resume on a DIFFERENT process or
 * instance after a crash — the in-process {@link InMemoryRunStore} only survives
 * within one process. `ioredis` is a type-only import (no runtime dependency).
 */
import type { RunCheckpoint, RunStore } from '@/agent/run-store'
import type { Redis } from 'ioredis'

/** Options for {@link RedisRunStore}. */
export interface RedisRunStoreOptions {
  /** Key prefix. Defaults to `"momo:run:"`. */
  keyPrefix?: string
  /**
   * Checkpoint TTL in seconds — a safety net so an abandoned run's checkpoint is
   * eventually reclaimed. Defaults to 86400 (1 day); set 0 for no expiry.
   */
  ttlSeconds?: number
}

/**
 * A Redis-backed {@link RunStore}, enabling cross-process resume:
 *
 * ```ts
 * import { RedisRunStore } from 'momo-agentic/redis'
 * const agent = new Agent({ model, tools, runStore: new RedisRunStore(redis) })
 * await agent.run('long task', { runId: 'job-42' })          // one process
 * // …another process, same Redis:
 * await agent.run('long task', { runId: 'job-42', resume: true })
 * ```
 */
export class RedisRunStore implements RunStore {
  private readonly prefix: string
  private readonly ttlSeconds: number

  constructor(
    private readonly redis: Redis,
    options: RedisRunStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? 'momo:run:'
    this.ttlSeconds = options.ttlSeconds ?? 86_400
  }

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const raw = await this.redis.get(this.prefix + runId)
    return raw ? (JSON.parse(raw) as RunCheckpoint) : undefined
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const key = this.prefix + checkpoint.runId
    const payload = JSON.stringify(checkpoint)
    if (this.ttlSeconds > 0) await this.redis.set(key, payload, 'EX', this.ttlSeconds)
    else await this.redis.set(key, payload)
  }

  async delete(runId: string): Promise<void> {
    await this.redis.del(this.prefix + runId)
  }
}
