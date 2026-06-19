import type { LoadHistoryOptions, Memory, MemoryFact } from '@/memory/memory'
/**
 * A {@link Memory} decorator that keeps short-term context bounded: once the
 * transcript grows past a threshold, older messages are compressed into a single
 * summary message while recent ones are kept verbatim. Wraps ANY inner Memory
 * and delegates fact (long-term) methods straight through, so it composes with
 * a durable/vector store underneath.
 *
 * Summarization is delegated to a {@link Summarizer} you implement (typically
 * with your own {@link LanguageModel}), so this
 * decorator stays provider-agnostic. The summary is cached and only recomputed
 * when the older-message count changes.
 */
import type { Message } from '@/shared/types'

/** Compresses a batch of messages into a short summary string. */
export interface Summarizer {
  summarize(messages: Message[], previousSummary?: string): Promise<string> | string
}

/** Options for {@link SummarizingMemory}. */
export interface SummarizingMemoryOptions {
  summarizer: Summarizer
  /** Summarize only when total messages exceed this. Defaults to 40. */
  threshold?: number
  /** Number of most-recent messages kept verbatim. Defaults to 20. */
  keepRecent?: number
}

export class SummarizingMemory implements Memory {
  private readonly summarizer: Summarizer
  private readonly threshold: number
  private readonly keepRecent: number
  private cache: { count: number; summary: string } | null = null

  constructor(
    private readonly inner: Memory,
    options: SummarizingMemoryOptions,
  ) {
    this.summarizer = options.summarizer
    this.threshold = options.threshold ?? 40
    this.keepRecent = options.keepRecent ?? 20
  }

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const all = await this.inner.loadHistory()
    if (all.length <= this.threshold) {
      return options?.limit !== undefined ? all.slice(-options.limit) : all
    }

    const older = all.slice(0, all.length - this.keepRecent)
    const recent = all.slice(-this.keepRecent)

    if (!this.cache || this.cache.count !== older.length) {
      const summary = await this.summarizer.summarize(older, this.cache?.summary)
      this.cache = { count: older.length, summary }
    }

    const summaryMessage: Message = {
      role: 'system',
      content: `[Conversation summary so far]\n${this.cache.summary}`,
    }
    const result = [summaryMessage, ...recent]
    return options?.limit !== undefined ? result.slice(-options.limit) : result
  }

  appendMessage(message: Message): Promise<void> | void {
    return this.inner.appendMessage(message)
  }

  // Long-term fact methods delegate straight to the inner store.
  rememberFact(key: string, value: string): Promise<void> | void {
    return this.inner.rememberFact?.(key, value)
  }

  recallFacts(): Promise<Record<string, string>> | Record<string, string> {
    return this.inner.recallFacts?.() ?? {}
  }

  searchFacts(query: string, options?: { limit?: number }): Promise<MemoryFact[]> | MemoryFact[] {
    return this.inner.searchFacts?.(query, options) ?? []
  }
}
