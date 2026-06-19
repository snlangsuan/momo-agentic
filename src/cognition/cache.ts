/**
 * Layer 5 — Cognition (response caching) · Layer 8 — Governance (cost control).
 *
 * A {@link LanguageModel} decorator that memoizes completions by their exact
 * input. When the same transcript + tools come around again, the cached
 * {@link ModelResponse} is returned instead of paying the provider for another
 * call — cutting cost and latency for deterministic prompts (temperature 0,
 * repeated questions, retried runs).
 *
 * The cache itself is an injected port ({@link ModelCache}), so it can be an
 * in-process map (shipped here) or a shared Redis/Memcached the host wraps — the
 * library never reaches for infrastructure. Like {@link redactModel}, the
 * wrapper exposes only `generate` (not `generateStream`): a cache hit has no
 * tokens to stream, so strategies transparently use the buffered path.
 */
import type { GenerateOptions, LanguageModel, ModelResponse } from '@/cognition/model'

/** Storage port for {@link cacheModel}. Implement to back the cache with anything. */
export interface ModelCache {
  get(key: string): Promise<ModelResponse | undefined> | ModelResponse | undefined
  set(key: string, value: ModelResponse): Promise<void> | void
}

/** Options for {@link cacheModel}. */
export interface CacheModelOptions {
  /** Backing store. Defaults to a new {@link InMemoryModelCache}. */
  cache?: ModelCache
  /**
   * Compute the cache key for a request. Defaults to a stable JSON of the model
   * id + messages + tools. Override to, e.g., ignore volatile metadata.
   */
  key?: (model: LanguageModel, options: GenerateOptions) => string
}

const defaultKey = (model: LanguageModel, options: GenerateOptions): string =>
  JSON.stringify({ id: model.id, messages: options.messages, tools: options.tools })

const clone = (value: ModelResponse): ModelResponse => ({
  ...value,
  toolCalls: value.toolCalls?.map((c) => ({ ...c, arguments: { ...c.arguments } })),
  usage: value.usage ? { ...value.usage } : undefined,
})

/** Options for {@link InMemoryModelCache}. */
export interface InMemoryModelCacheOptions {
  /** Entry lifetime in milliseconds. Omit for no expiry. */
  ttlMs?: number
  /** Max entries; oldest are evicted past this (simple FIFO). Defaults to 1000. */
  maxEntries?: number
}

/**
 * A simple in-process {@link ModelCache} with optional TTL and a size cap.
 * Suitable for a single instance; swap in a shared store for multi-instance.
 */
export class InMemoryModelCache implements ModelCache {
  private readonly store = new Map<string, { value: ModelResponse; expires: number }>()
  private readonly ttlMs?: number
  private readonly maxEntries: number

  constructor(options: InMemoryModelCacheOptions = {}) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries ?? 1000
  }

  get(key: string): ModelResponse | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expires && entry.expires <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: ModelResponse): void {
    this.store.set(key, { value, expires: this.ttlMs ? Date.now() + this.ttlMs : 0 })
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
  }

  /** Drop all cached entries. */
  clear(): void {
    this.store.clear()
  }
}

/**
 * Wrap a {@link LanguageModel} so identical requests are served from a
 * {@link ModelCache} instead of calling the provider again.
 *
 * @example
 * ```ts
 * const cached = cacheModel(model, { cache: new InMemoryModelCache({ ttlMs: 60_000 }) })
 * const agent = new Agent({ model: cached })
 * ```
 */
export function cacheModel(model: LanguageModel, options: CacheModelOptions = {}): LanguageModel {
  const cache = options.cache ?? new InMemoryModelCache()
  const keyOf = options.key ?? defaultKey

  return {
    id: model.id,
    async generate(generateOptions) {
      const key = keyOf(model, generateOptions)
      const hit = await cache.get(key)
      if (hit) return clone(hit)
      const response = await model.generate(generateOptions)
      await cache.set(key, clone(response))
      return response
    },
  }
}
