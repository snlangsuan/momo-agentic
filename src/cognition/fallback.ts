/**
 * Layer 5 — Cognition (resilience).
 *
 * `withFallback` chains several {@link LanguageModel}s into one: a call tries the
 * primary, and on a qualifying failure falls through to the next, and the next,
 * until one succeeds or all are exhausted. A transparent decorator like
 * {@link withRetry} — strategies and the agent see a single model. Pair the two
 * (`withFallback([withRetry(a), withRetry(b)])`) to retry each model before
 * moving on.
 *
 * Streaming caveat: a `generateStream` failure only falls back when it happens
 * BEFORE the first token is yielded. Once tokens are out they can't be un-yielded,
 * so a mid-stream error propagates instead of silently restarting on another model.
 *
 * Attribution note: the wrapper keeps a stable `id` (the primary's by default) so
 * caching keys and step logs stay consistent. To observe which model actually
 * answered after a fallback, use {@link FallbackOptions.onFallback}.
 */
import type { GenerateOptions, LanguageModel, ModelResponse, ModelStreamChunk } from './model'

/** Tuning for {@link withFallback}. */
export interface FallbackOptions {
  /**
   * Whether an error should trigger falling through to the next model. Defaults to
   * anything that is not an abort (an aborted run stops immediately).
   */
  fallbackIf?: (error: unknown) => boolean
  /**
   * Called when a model fails and the next one is about to be tried, with the
   * error, the id of the model that failed, and the id taking over. For logging.
   */
  onFallback?: (info: { error: unknown; from: string; to: string }) => void
  /**
   * `id` to report for the combined model. Defaults to the primary model's id, so
   * cache keys and `step`/`token` event attribution stay stable across fallbacks.
   */
  id?: string
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

/**
 * Combine models into a primary-with-fallbacks chain. Order is priority order:
 * the first model is tried first. Composes with everything else, e.g.
 * `new Agent({ model: withFallback([primary, backup]) })`.
 *
 * @example
 * ```ts
 * const model = withFallback([opus, haiku], {
 *   onFallback: ({ from, to }) => console.warn(`${from} failed → ${to}`),
 * })
 * ```
 */
export function withFallback(
  models: LanguageModel[],
  options: FallbackOptions = {},
): LanguageModel {
  const primary = models[0]
  if (!primary) throw new Error('withFallback requires at least one model')
  const fallbackIf = options.fallbackIf ?? ((error) => !isAbort(error))
  const id = options.id ?? primary.id

  /** Try each model in order; on a qualifying error move to the next. */
  const generate = async (opts: GenerateOptions): Promise<ModelResponse> => {
    let lastError: unknown
    for (let i = 0; i < models.length; i++) {
      const model = models[i]
      if (!model) continue
      try {
        return await model.generate(opts)
      } catch (error) {
        lastError = error
        const next = models[i + 1]
        if (!next || !fallbackIf(error)) throw error
        options.onFallback?.({ error, from: model.id, to: next.id })
      }
    }
    throw lastError
  }

  const wrapped: LanguageModel = { id, generate }

  // Expose streaming when ANY model can stream; models without it use generate.
  if (models.some((m) => m.generateStream)) {
    wrapped.generateStream = (opts) => streamFallback(models, fallbackIf, options.onFallback, opts)
  }

  return wrapped
}

/**
 * Streaming variant of the fallback chain: stream from the first model that gets
 * going, falling through only on a failure BEFORE the first token (mid-stream
 * errors propagate). A model without `generateStream` is used via `generate`.
 */
async function* streamFallback(
  models: LanguageModel[],
  fallbackIf: (error: unknown) => boolean,
  onFallback: FallbackOptions['onFallback'],
  opts: GenerateOptions,
): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
  let lastError: unknown
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (!model) continue
    let yielded = false
    try {
      if (!model.generateStream) return await model.generate(opts)
      const iterator = model.generateStream(opts)
      let next = await iterator.next()
      while (!next.done) {
        yielded = true
        yield next.value
        next = await iterator.next()
      }
      return next.value
    } catch (error) {
      lastError = error
      const nextModel = models[i + 1]
      // Past the first token, or unqualified errors / last model → propagate.
      if (yielded || !nextModel || !fallbackIf(error)) throw error
      onFallback?.({ error, from: model.id, to: nextModel.id })
    }
  }
  throw lastError
}
