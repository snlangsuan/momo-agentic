/**
 * A real long-term {@link Memory} backed by Postgres + pgvector. Conversation
 * goes in a table; facts get an embedding column and `searchFacts` does semantic
 * (vector) retrieval — the same `Memory` port the agent already uses, now durable
 * and semantic.
 *
 * The embedder is injected, so you choose the model (multilingual `bge-m3` works
 * great for Thai — see index.ts). Provider-agnostic: swap Postgres for any store
 * by implementing `Memory` the same way.
 */
import type { LoadHistoryOptions, Memory, MemoryFact, Message } from '../../src/index'

/** Minimal structural type satisfied by a `pg` Pool/Client (avoids a hard dep). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Turn text into an embedding vector. Plug in any model (Ollama, OpenAI, ...). */
export type Embedder = (text: string) => Promise<number[]> | number[]

export interface PgVectorMemoryOptions {
  client: SqlClient
  embed: Embedder
  /** Embedding dimensions (must match the model, e.g. bge-m3 = 1024). */
  dimensions: number
  /** Scope rows to a user/session. Defaults to `"default"`. */
  userId?: string
}

/** pgvector text literal, e.g. `[0.1,0.2,...]`. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

export class PgVectorMemory implements Memory {
  private readonly userId: string

  constructor(private readonly opts: PgVectorMemoryOptions) {
    this.userId = opts.userId ?? 'default'
  }

  /** Create the extension + tables (idempotent). Call once at startup. */
  async init(): Promise<void> {
    const { client, dimensions } = this.opts
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent_messages (
         id bigserial PRIMARY KEY,
         user_id text NOT NULL,
         role text NOT NULL,
         content text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent_facts (
         user_id text NOT NULL,
         key text NOT NULL,
         value text NOT NULL,
         embedding vector(${dimensions}) NOT NULL,
         PRIMARY KEY (user_id, key)
       )`,
    )
  }

  // --- short-term: conversation ---
  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const limit = options?.limit ?? 100
    const { rows } = await this.opts.client.query(
      'SELECT role, content FROM agent_messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [this.userId, limit],
    )
    return rows
      .reverse()
      .map((r) => ({ role: r.role as Message['role'], content: String(r.content) }))
  }

  async appendMessage(message: Message): Promise<void> {
    await this.opts.client.query(
      'INSERT INTO agent_messages (user_id, role, content) VALUES ($1, $2, $3)',
      [this.userId, message.role, message.content],
    )
  }

  // --- long-term: facts (semantic) ---
  async rememberFact(key: string, value: string): Promise<void> {
    const embedding = toVectorLiteral([...(await this.opts.embed(value))])
    await this.opts.client.query(
      `INSERT INTO agent_facts (user_id, key, value, embedding) VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding`,
      [this.userId, key, value, embedding],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const { rows } = await this.opts.client.query(
      'SELECT key, value FROM agent_facts WHERE user_id = $1',
      [this.userId],
    )
    return Object.fromEntries(rows.map((r) => [String(r.key), String(r.value)]))
  }

  /** Cosine-nearest facts to `query` (pgvector `<=>` operator). */
  async searchFacts(query: string, options?: { limit?: number }): Promise<MemoryFact[]> {
    const embedding = toVectorLiteral([...(await this.opts.embed(query))])
    const limit = options?.limit ?? 8
    const { rows } = await this.opts.client.query(
      `SELECT key, value, 1 - (embedding <=> $2::vector) AS score
         FROM agent_facts WHERE user_id = $1
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [this.userId, embedding, limit],
    )
    return rows.map((r) => ({ key: String(r.key), value: String(r.value), score: Number(r.score) }))
  }
}
