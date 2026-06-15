/**
 * Layer 5 — Cognition (resilience).
 *
 * `withRetry` wraps a {@link LanguageModel} so transient provider failures (rate
 * limits, 5xx, dropped connections) are retried with backoff — without any
 * strategy or the agent knowing. It is a transparent decorator: the returned
 * model has the same `id` and honors the same `signal`, so an aborted run stops
 * retrying immediately.
 *
 * Streaming caveat: a `generateStream` failure is only retried when it happens
 * BEFORE the first token is yielded (e.g. connection setup). Once tokens have been
 * emitted they can't be un-emitted, so a mid-stream error propagates.
 */
import type { GenerateOptions, LanguageModel, ModelResponse, ModelStreamChunk } from './model'

/** Tuning for {@link withRetry}. */
export interface RetryOptions {
  /** Retry attempts after the first try (total tries = retries + 1). Defaults to 2. */
  retries?: number
  /** Delay before retry attempt `n` (1-based), in ms. Defaults to exponential backoff. */
  delayMs?: (attempt: number) => number
  /** Whether an error is retryable. Defaults to anything that is not an abort. */
  retryIf?: (error: unknown) => boolean
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

/**
 * Wrap a model with retry + backoff on transient errors. Composes with everything
 * else: `new Agent({ model: withRetry(myModel, { retries: 3 }) })`.
 */
export function withRetry(model: LanguageModel, options: RetryOptions = {}): LanguageModel {
  const retries = options.retries ?? 2
  const delayMs = options.delayMs ?? ((attempt) => Math.min(200 * 2 ** (attempt - 1), 5000))
  const retryIf = options.retryIf ?? ((error) => !isAbort(error))

  const shouldRetry = (error: unknown, attempt: number): boolean =>
    attempt <= retries && retryIf(error)

  const wrapped: LanguageModel = {
    id: model.id,
    async generate(opts: GenerateOptions): Promise<ModelResponse> {
      let attempt = 0
      while (true) {
        try {
          return await model.generate(opts)
        } catch (error) {
          attempt++
          if (!shouldRetry(error, attempt)) throw error
          await sleep(delayMs(attempt), opts.signal)
        }
      }
    },
  }

  if (model.generateStream) {
    const stream = model.generateStream.bind(model)
    wrapped.generateStream = async function* (
      opts: GenerateOptions,
    ): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
      let attempt = 0
      while (true) {
        const iterator = stream(opts)
        let first: IteratorResult<ModelStreamChunk, ModelResponse>
        try {
          // Only the FIRST step is retryable — past it, tokens are already out.
          first = await iterator.next()
        } catch (error) {
          attempt++
          if (!shouldRetry(error, attempt)) throw error
          await sleep(delayMs(attempt), opts.signal)
          continue
        }
        if (first.done) return first.value
        yield first.value
        let next = await iterator.next()
        while (!next.done) {
          yield next.value
          next = await iterator.next()
        }
        return next.value
      }
    }
  }

  return wrapped
}
