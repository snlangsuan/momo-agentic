/**
 * Memory (Layer 6) — the standalone fact + summarizer helpers.
 *
 * These let a custom agent or tool reuse the SAME logic the built-in `Agent`
 * uses, without re-deriving it:
 *   - `recallRelevantFacts` — pick the facts worth injecting for a query. When
 *     the whole set fits the `limit` it returns ALL of them (so always-relevant
 *     facts like a name are never dropped); only on overflow does it fall back to
 *     the backend's semantic `searchFacts` ranking.
 *   - `formatFacts` — render facts as a `- key: value` bullet list for a prompt.
 *   - `createModelSummarizer` — turn any `LanguageModel` into a `Summarizer`, so
 *     `SummarizingMemory` no longer needs a hand-written summarize loop.
 *
 * Run with:  bun run examples/memory-utils.ts
 */
import {
  InMemoryMemory,
  SummarizingMemory,
  createModelSummarizer,
  formatFacts,
  recallRelevantFacts,
} from '../src/index'
import { fnModel } from './_support/mock-model'

// ── Part 1: recallRelevantFacts + formatFacts ───────────────────────────────
const memory = new InMemoryMemory({
  facts: {
    name: 'Somchai',
    role: 'backend engineer',
    'favorite language': 'TypeScript',
    'commute hobby': 'road cycling',
    timezone: 'Asia/Bangkok',
  },
})

// Few enough to fit the limit → every fact comes back, query is ignored.
const all = await recallRelevantFacts(memory, 'anything', { limit: 8 })
console.log('All facts (fits within limit):')
console.log(formatFacts(all))

// Tighten the limit so the set overflows → semantic searchFacts ranks by query.
const query = 'his cycling hobby and favorite language'
const ranked = await recallRelevantFacts(memory, query, { limit: 2 })
console.log(`\nTop 2 for "${query}" (overflow → ranked):`)
console.log(formatFacts(ranked))

// Drop the rendered block straight into a system prompt.
const systemPrompt = `You are a helpful assistant.\n\nKnown facts about the user:\n${formatFacts(all)}`
console.log('\n--- system prompt fragment ---')
console.log(systemPrompt)

// ── Part 2: createModelSummarizer + SummarizingMemory ───────────────────────
// A real adapter would call an LLM; this mock just proves the wiring + prompt.
const model = fnModel('mock:summarizer', (options) => {
  const transcript = options.messages.at(-1)?.content ?? ''
  console.log(`\n  🧠 summarizer model called (${transcript.length} chars of transcript)`)
  return { content: 'User greeted the assistant and asked three onboarding questions.' }
})

const summarizer = createModelSummarizer(model, { maxWords: 40 })
const chat = new SummarizingMemory(new InMemoryMemory(), {
  summarizer,
  threshold: 4,
  keepRecent: 2,
})

for (let i = 1; i <= 3; i++) {
  await chat.appendMessage({ role: 'user', content: `onboarding question ${i}` })
  await chat.appendMessage({ role: 'assistant', content: `answer ${i}` })
}

const view = await chat.loadHistory()
console.log('\nWhat the model now sees (older turns folded into one summary):')
for (const m of view) console.log(`  ${m.role}: ${m.content}`)
