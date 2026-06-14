/**
 * Memory (Layer 6) — implement the `Memory` port over your own store, add
 * semantic `searchFacts`, and bound short-term growth with `SummarizingMemory`.
 * Here the "store" is a plain object standing in for Redis/Postgres/a vector DB.
 *
 * Run with:  bun run examples/custom-memory.ts
 */
import { Agent, type Memory, type MemoryFact, type Message, SummarizingMemory } from '../src/index'
import { scriptModel } from './_support/mock-model'

/** A toy custom backend. Replace the internals with your real store. */
class ObjectMemory implements Memory {
  private history: Message[] = []
  private facts: Record<string, string> = {}

  loadHistory(options?: { limit?: number }): Message[] {
    return options?.limit ? this.history.slice(-options.limit) : [...this.history]
  }
  appendMessage(message: Message): void {
    this.history.push(message)
  }
  rememberFact(key: string, value: string): void {
    this.facts[key] = value
  }
  recallFacts(): Record<string, string> {
    return { ...this.facts }
  }
  // Semantic recall (toy: substring match). A real impl would use embeddings.
  searchFacts(query: string, options?: { limit?: number }): MemoryFact[] {
    const q = query.toLowerCase()
    const hits = Object.entries(this.facts)
      .filter(
        ([k, v]) =>
          q.includes(k.toLowerCase()) ||
          v
            .toLowerCase()
            .split(' ')
            .some((w) => q.includes(w)),
      )
      .map(([key, value]) => ({ key, value, score: 1 }))
    return options?.limit ? hits.slice(0, options.limit) : hits
  }
}

const store = new ObjectMemory()
store.rememberFact('allergy', 'allergic to peanuts')
store.rememberFact('city', 'lives in Bangkok')

// Wrap the store so long transcripts get summarized (short-term bounding).
const memory = new SummarizingMemory(store, {
  summarizer: { summarize: (msgs) => `(${msgs.length} earlier messages summarized)` },
  threshold: 6,
  keepRecent: 2,
})

const model = scriptModel([{ content: 'Noted — I will avoid peanuts.' }])
const agent = new Agent({ model, memory, factRecallLimit: 1 })

await agent.run('any peanuts in this recipe?')

// The relevant fact ('allergy') was injected; conversation was persisted to the store.
console.log('Facts in store:', store.recallFacts())
console.log('History length:', store.loadHistory().length)
