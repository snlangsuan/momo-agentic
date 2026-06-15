/**
 * Layer 8 — Governance (cost / rate-limit enforcement).
 *
 * Where {@link UsageTracker} *measures* usage, a {@link UsageLimiter} *enforces* a
 * ceiling: it is consulted before every run and may block it, and is told the
 * actual usage afterwards so it can keep a running tally. It is an injected port,
 * so the accounting can live anywhere — in-process, Redis, a billing service.
 * Blocking raises an `AgentError` tagged `"rate_limit"`.
 */
import type { Usage } from '../shared/types'

/** Identifies who/what a limiter decision is about. */
export interface LimiterContext {
  agentName: string
  /** The user's input for this turn. */
  input: string
  /** Per-run data from {@link RunOptions.metadata} (e.g. a `userId` to key on). */
  metadata: Record<string, unknown>
}

/** A limiter's ruling for one run: proceed, or block with an optional reason. */
export type LimiterVerdict = { allowed: true } | { allowed: false; reason?: string }

/** Injected ceiling consulted before a run and notified of usage after it. */
export interface UsageLimiter {
  readonly name: string
  /** Called before a run. Return `{ allowed: false }` to block it. */
  acquire(context: LimiterContext): Promise<LimiterVerdict> | LimiterVerdict
  /** Called after a successful run with the actual token usage, for accounting. */
  record?(usage: Usage, context: LimiterContext): Promise<void> | void
}

/** Options for {@link InMemoryUsageLimiter}. */
export interface InMemoryUsageLimiterOptions {
  /** Max runs allowed per key. */
  maxRuns?: number
  /** Max cumulative total tokens allowed per key. */
  maxTokens?: number
  /** Bucket key for a context (e.g. a userId). Defaults to one global bucket. */
  key?: (context: LimiterContext) => string
}

/**
 * A ready-made in-process {@link UsageLimiter} that caps runs and/or cumulative
 * tokens per key. Counts never reset on their own — call {@link InMemoryUsageLimiter.reset}
 * to roll a window, or implement {@link UsageLimiter} for time-based/durable limits.
 */
export class InMemoryUsageLimiter implements UsageLimiter {
  readonly name = 'in-memory-usage-limiter'
  private readonly runs = new Map<string, number>()
  private readonly tokens = new Map<string, number>()

  constructor(private readonly options: InMemoryUsageLimiterOptions) {}

  private keyFor(context: LimiterContext): string {
    return this.options.key?.(context) ?? 'global'
  }

  acquire(context: LimiterContext): LimiterVerdict {
    const key = this.keyFor(context)
    const { maxRuns, maxTokens } = this.options
    if (maxRuns !== undefined && (this.runs.get(key) ?? 0) >= maxRuns) {
      return { allowed: false, reason: `run limit (${maxRuns}) reached` }
    }
    if (maxTokens !== undefined && (this.tokens.get(key) ?? 0) >= maxTokens) {
      return { allowed: false, reason: `token budget (${maxTokens}) exhausted` }
    }
    return { allowed: true }
  }

  record(usage: Usage, context: LimiterContext): void {
    const key = this.keyFor(context)
    this.runs.set(key, (this.runs.get(key) ?? 0) + 1)
    this.tokens.set(key, (this.tokens.get(key) ?? 0) + usage.totalTokens)
  }

  /** Clear all counters (e.g. when a rate-limit window rolls over). */
  reset(): void {
    this.runs.clear()
    this.tokens.clear()
  }
}
