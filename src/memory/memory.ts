/**
 * Layer 6 — Memory.
 *
 * Two complementary tiers per the theory, split into focused ports:
 * - {@link ConversationMemory} — the running transcript (SHORT-TERM context).
 * - {@link FactMemory} — durable facts/preferences/personality (LONG-TERM),
 *   with optional semantic retrieval for vector-backed stores.
 *
 * {@link Memory} combines them: conversation is required, facts are optional so
 * a backend can provide short-term only. Implement over any store — an
 * in-process map, Redis, Postgres, or an external memory/vector SDK — without
 * the agent core knowing the difference (Layer 1 stays injected).
 */
import type { Message } from '@/shared/types'

/** Options for loading conversation history. */
export interface LoadHistoryOptions {
  /** Cap on how many recent messages to return. */
  limit?: number
}

/** SHORT-TERM: the running conversation transcript. */
export interface ConversationMemory {
  /** Return prior conversation messages (oldest → newest). */
  loadHistory(options?: LoadHistoryOptions): Promise<Message[]> | Message[]
  /** Append a message to the conversation. */
  appendMessage(message: Message): Promise<void> | void
}

/** A durable fact, optionally scored when returned from a semantic search. */
export interface MemoryFact {
  key: string
  value: string
  /** Relevance score in [0,1] when produced by {@link FactMemory.searchFacts}. */
  score?: number
}

/** LONG-TERM: durable facts, preferences, and personality about the user. */
export interface FactMemory {
  /** Store or update a durable fact. */
  rememberFact(key: string, value: string): Promise<void> | void
  /** Return all durable facts as a flat key→value map. */
  recallFacts(): Promise<Record<string, string>> | Record<string, string>
  /**
   * OPTIONAL semantic retrieval: return the facts most relevant to `query`.
   * Vector-backed stores implement this for relevance ranking; simpler stores
   * may omit it (the agent then falls back to {@link FactMemory.recallFacts}).
   */
  searchFacts?(query: string, options?: { limit?: number }): Promise<MemoryFact[]> | MemoryFact[]
}

/**
 * Pluggable memory backend: required short-term conversation plus optional
 * long-term fact methods.
 */
export interface Memory extends ConversationMemory, Partial<FactMemory> {}
