import type { LoadHistoryOptions, Memory, MemoryFact } from '@/memory/memory'
import type { Message } from '@/shared/types'

/** Lowercase word tokens of length ≥ 2, for the keyword-overlap scorer. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
}

/**
 * Default zero-dependency {@link Memory} backed by process memory.
 *
 * Implements both tiers: conversation history (short-term) and facts
 * (long-term), including a keyword-overlap `searchFacts` so the semantic-recall
 * path is exercisable without a vector store. Swap in a durable/vector-backed
 * implementation for production long-term memory. State lives only for the
 * instance's lifetime.
 */
export class InMemoryMemory implements Memory {
  private readonly messages: Message[] = []
  private readonly facts = new Map<string, string>()

  constructor(seed?: { messages?: Message[]; facts?: Record<string, string> }) {
    if (seed?.messages) this.messages.push(...seed.messages)
    if (seed?.facts) {
      for (const [k, v] of Object.entries(seed.facts)) this.facts.set(k, v)
    }
  }

  loadHistory(options?: LoadHistoryOptions): Message[] {
    if (options?.limit !== undefined) {
      return this.messages.slice(-options.limit)
    }
    return [...this.messages]
  }

  appendMessage(message: Message): void {
    this.messages.push(message)
  }

  rememberFact(key: string, value: string): void {
    this.facts.set(key, value)
  }

  recallFacts(): Record<string, string> {
    return Object.fromEntries(this.facts)
  }

  /** Keyword-overlap ranking — a dependency-free stand-in for vector search. */
  searchFacts(query: string, options?: { limit?: number }): MemoryFact[] {
    const queryTokens = new Set(tokenize(query))
    if (queryTokens.size === 0) return []

    const scored: MemoryFact[] = []
    for (const [key, value] of this.facts) {
      const factTokens = new Set(tokenize(`${key} ${value}`))
      let overlap = 0
      for (const token of factTokens) {
        if (queryTokens.has(token)) overlap++
      }
      if (overlap > 0) {
        scored.push({ key, value, score: overlap / queryTokens.size })
      }
    }

    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    return options?.limit !== undefined ? scored.slice(0, options.limit) : scored
  }
}
