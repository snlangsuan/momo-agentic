/**
 * Layer 6 — Memory (long-term fact helpers).
 *
 * Small, dependency-free utilities for working with the {@link FactMemory} tier
 * outside of {@link Agent}. They make custom agents and tools recall and render
 * durable facts the same way the built-in {@link Agent} does, without
 * re-deriving the selection logic each time.
 */
import type { FactMemory, MemoryFact } from '@/memory/memory'

/** Options for {@link recallRelevantFacts}. */
export interface RecallOptions {
  /** Max facts to return. Defaults to 8. */
  limit?: number
}

/** Just the read side of {@link FactMemory}, both methods optional. */
export type FactSource = Partial<Pick<FactMemory, 'recallFacts' | 'searchFacts'>>

/**
 * Select the facts most worth injecting for `query`, mirroring {@link Agent}'s
 * strategy: when the whole fact set fits within `limit`, return all of it (so
 * always-relevant facts like the user's name are never dropped); only when it
 * overflows does the backend's semantic `searchFacts` rank by relevance. Falls
 * back gracefully when a backend exposes only one of the two methods.
 *
 * @example
 * ```ts
 * const facts = await recallRelevantFacts(memory, userInput, { limit: 5 })
 * systemPrompt += `\n\n${formatFacts(facts)}`
 * ```
 */
export async function recallRelevantFacts(
  memory: FactSource,
  query: string,
  options: RecallOptions = {},
): Promise<MemoryFact[]> {
  const limit = options.limit ?? 8

  if (memory.recallFacts) {
    const entries = Object.entries(await memory.recallFacts())
    if (entries.length <= limit) {
      return entries.map(([key, value]) => ({ key, value }))
    }
    if (memory.searchFacts) {
      return memory.searchFacts(query, { limit })
    }
    return entries.slice(0, limit).map(([key, value]) => ({ key, value }))
  }

  // Backend exposes only semantic search (no full recall).
  if (memory.searchFacts) {
    return memory.searchFacts(query, { limit })
  }
  return []
}

/**
 * Render facts as a `- key: value` bullet list for inclusion in a prompt.
 * Accepts the list returned by {@link recallRelevantFacts} or a raw
 * `key→value` map from {@link FactMemory.recallFacts}. Returns `''` when empty.
 */
export function formatFacts(facts: MemoryFact[] | Record<string, string>): string {
  const list: MemoryFact[] = Array.isArray(facts)
    ? facts
    : Object.entries(facts).map(([key, value]) => ({ key, value }))
  if (list.length === 0) return ''
  return list.map((f) => `- ${f.key}: ${f.value}`).join('\n')
}
