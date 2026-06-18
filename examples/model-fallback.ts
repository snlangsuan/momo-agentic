/**
 * Cognition (Layer 5) — model resilience with `withFallback`.
 *
 * Chain models into one: the call tries the primary, and on a qualifying error
 * falls through to the next. A transparent decorator — the Agent sees a single
 * model. Compose with `withRetry` to retry each model before moving on:
 * `withFallback([withRetry(a), withRetry(b)])`.
 *
 * Run with:  bun run examples/model-fallback.ts
 */
import { Agent, type LanguageModel, withFallback } from '../src/index'
import { fnModel } from './_support/mock-model'

// Primary always fails (simulating an outage / rate limit).
const primary: LanguageModel = fnModel('primary', () => {
  throw new Error('503 service unavailable')
})

// Backup answers fine.
const backup: LanguageModel = fnModel('backup', () => ({
  content: 'Answer from the backup model.',
}))

const model = withFallback([primary, backup], {
  onFallback: ({ from, to, error }) =>
    console.log(`⚠️  ${from} failed (${(error as Error).message}) → falling back to ${to}`),
})

const result = await new Agent({ model }).run('hello?')
console.log(`\n✅ ${result.output}`)
// The wrapper keeps a stable id (the primary's) for cache/log consistency...
console.log(`   model id: ${model.id}`)
// ...while step attribution shows the id the wrapper reports.
console.log(`   usageByModel keys: ${Object.keys(result.usageByModel).join(', ')}`)
