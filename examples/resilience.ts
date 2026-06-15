/**
 * Cognition (Layer 5) — resilience for production bots:
 *  - `withRetry(model, ...)` retries transient model failures (rate limits, 5xx,
 *    dropped connections) with backoff. Aborts are never retried.
 *  - `AgentConfig.timeoutMs` aborts the whole run after a deadline and raises an
 *    `AgentError` tagged `"timeout"`.
 *
 * Run with:  bun run examples/resilience.ts
 */
import { Agent, AgentError, type LanguageModel, withRetry } from '../src/index'

// 1) Retry — a flaky model that fails twice, then succeeds.
let attempts = 0
const flaky: LanguageModel = {
  id: 'flaky',
  generate: () => {
    attempts++
    if (attempts < 3) return Promise.reject(new Error('503 rate limited'))
    return Promise.resolve({ content: 'recovered after a couple of retries' })
  },
}
const retried = await new Agent({
  model: withRetry(flaky, { retries: 3, delayMs: () => 0 }), // delay 0 to keep the demo fast
}).run('go')
console.log(`♻️  retry: "${retried.output}" (took ${attempts} attempts)`)

// 2) Timeout — a model that hangs until the run's deadline aborts it.
const hang: LanguageModel = {
  id: 'hang',
  generate: (opts) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
    }),
}
try {
  await new Agent({ model: hang, timeoutMs: 100 }).run('go')
} catch (error) {
  if (error instanceof AgentError) console.log(`⏱️  timeout: AgentError(stage="${error.stage}")`)
}
