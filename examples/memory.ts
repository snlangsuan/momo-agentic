/**
 * Memory example (Layer 6): short-term conversation + long-term facts.
 *
 * Demonstrates the full long-term loop — the agent WRITES a fact via the
 * auto-registered `remember_fact` tool, and a later turn RECALLS it (semantically
 * when facts exceed the limit) into the system prompt. Wrap any memory in
 * `SummarizingMemory` to bound short-term context growth.
 *
 * Run with:  bun run examples/memory.ts
 */
import { Agent, InMemoryMemory, type LanguageModel, SummarizingMemory } from '../src/index'

// Long-term store shared across turns. Swap for a durable/vector-backed impl.
const store = new InMemoryMemory()

// Bound short-term context: summarize once the transcript passes the threshold.
const memory = new SummarizingMemory(store, {
  summarizer: { summarize: (msgs) => `(${msgs.length} earlier messages summarized)` },
  threshold: 40,
  keepRecent: 20,
})

let turn = 0
const model: LanguageModel = {
  id: 'mock-model',
  generate: () => {
    turn++
    if (turn === 1) {
      // First turn: the model decides to remember the user's name.
      return Promise.resolve({
        content: '',
        toolCalls: [
          { id: 'c1', name: 'remember_fact', arguments: { key: 'name', value: 'Somchai' } },
        ],
      })
    }
    return Promise.resolve({ content: 'Got it, Somchai!' })
  },
}

const agent = new Agent({ model, memory, rememberFacts: true })

await agent.run('Hi, my name is Somchai.')
console.log('Stored facts:', store.recallFacts())
// → { name: 'Somchai' } — written to long-term memory, survives across runs.
console.log('Conversation length:', store.loadHistory().length)
