import type { LoadHistoryOptions, Memory } from '@/memory/memory'
import type { Message } from '@/shared/types'
/**
 * Layer 6 — Memory, backed by MongoDB (via the `mongodb` driver).
 *
 * Short-term conversation lives in a messages collection (ordered by insertion
 * `_id`), long-term facts in a per-namespace document. `mongodb` is a type-only
 * import — this module pulls in NO runtime dependency; you pass a `Db` in. It is
 * an optional peer dependency: install it only if you import `momo-agentic/mongo`.
 *
 * Pair the long-term side with a faster short-term store via `composeMemory`:
 * short-term Redis + long-term Mongo.
 */
import type { Collection, Db, UpdateFilter } from 'mongodb'

/** Options for {@link MongoMemory}. */
export interface MongoMemoryOptions {
  /** Key namespace for this scope, e.g. `user:u1` or `chat:u1:t1`. */
  namespace: string
  /** Conversation collection name. Defaults to `"momo_messages"`. */
  messagesCollection?: string
  /** Facts collection name. Defaults to `"momo_facts"`. */
  factsCollection?: string
}

interface MessageDoc {
  namespace: string
  message: Message
}

interface FactsDoc {
  _id: string
  facts: Record<string, string>
}

/**
 * A MongoDB-backed {@link Memory}: conversation history (one document per
 * message) plus durable facts (one document per namespace).
 *
 * ```ts
 * import { MongoClient } from 'mongodb'
 * import { MongoMemory } from 'momo-agentic/mongo'
 *
 * const db = (await MongoClient.connect(process.env.MONGO_URL!)).db('app')
 * const memory = new MongoMemory(db, { namespace: `user:${userId}` })
 * const agent = new Agent({ model, memory, rememberFacts: true })
 * ```
 */
export class MongoMemory implements Memory {
  private readonly messages: Collection<MessageDoc>
  private readonly facts: Collection<FactsDoc>
  private readonly namespace: string

  constructor(db: Db, options: MongoMemoryOptions) {
    this.namespace = options.namespace
    this.messages = db.collection<MessageDoc>(options.messagesCollection ?? 'momo_messages')
    this.facts = db.collection<FactsDoc>(options.factsCollection ?? 'momo_facts')
  }

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const query = this.messages.find({ namespace: this.namespace })
    if (options?.limit) {
      // Most recent N (by insertion order), returned oldest → newest.
      const recent = await query.sort({ _id: -1 }).limit(options.limit).toArray()
      return recent.reverse().map((doc) => doc.message)
    }
    const all = await query.sort({ _id: 1 }).toArray()
    return all.map((doc) => doc.message)
  }

  async appendMessage(message: Message): Promise<void> {
    await this.messages.insertOne({ namespace: this.namespace, message })
  }

  async rememberFact(key: string, value: string): Promise<void> {
    const update = { $set: { [`facts.${key}`]: value } } as UpdateFilter<FactsDoc>
    await this.facts.updateOne({ _id: this.namespace }, update, { upsert: true })
  }

  async recallFacts(): Promise<Record<string, string>> {
    const doc = await this.facts.findOne({ _id: this.namespace })
    return doc?.facts ?? {}
  }
}
