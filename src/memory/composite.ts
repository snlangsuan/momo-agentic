/**
 * Layer 6 — Memory composition.
 *
 * The two memory tiers are independent ports ({@link ConversationMemory} for
 * SHORT-TERM transcript, {@link FactMemory} for LONG-TERM facts), so they can be
 * backed by DIFFERENT stores. {@link composeMemory} stitches one of each into a
 * single {@link Memory} the agent consumes — e.g. conversation in Redis (fast,
 * TTL'd) and durable facts in Mongo/Postgres.
 */
import type { ConversationMemory, FactMemory, LoadHistoryOptions, Memory } from '@/memory/memory'
import type { Message } from '@/shared/types'

/** The two backends to combine. `facts` is optional (short-term only). */
export interface ComposeMemoryOptions {
  /** Short-term transcript backend. */
  conversation: ConversationMemory
  /** Long-term fact backend. Omit for conversation-only memory. */
  facts?: FactMemory
}

/**
 * Combine a {@link ConversationMemory} and a {@link FactMemory} into one
 * {@link Memory}. Conversation calls route to `conversation`; fact calls route to
 * `facts` (absent when no fact backend is given, so the agent treats long-term
 * memory as unavailable). `searchFacts` is forwarded only when the fact backend
 * implements it.
 *
 * @example Short-term Redis + long-term Mongo
 * ```ts
 * import { composeMemory } from 'momo-agentic'
 * import { RedisMemory } from 'momo-agentic/redis'
 * import { MongoMemory } from 'momo-agentic/mongo'
 *
 * const memory = composeMemory({
 *   conversation: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 }),
 *   facts: new MongoMemory(db, { namespace: `user:${userId}` }),
 * })
 * const agent = new Agent({ model, memory, rememberFacts: true })
 * ```
 */
export function composeMemory(options: ComposeMemoryOptions): Memory {
  const { conversation, facts } = options

  const memory: Memory = {
    loadHistory: (opts?: LoadHistoryOptions) => conversation.loadHistory(opts),
    appendMessage: (message: Message) => conversation.appendMessage(message),
  }

  if (facts) {
    memory.rememberFact = (key, value) => facts.rememberFact(key, value)
    memory.recallFacts = () => facts.recallFacts()
    if (facts.searchFacts) {
      const search = facts.searchFacts.bind(facts)
      memory.searchFacts = (query, opts) => search(query, opts)
    }
  }

  return memory
}
