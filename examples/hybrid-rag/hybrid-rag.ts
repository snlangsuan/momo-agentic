/**
 * Hybrid RAG for Thai (+ English): dense (pgvector) + sparse (Postgres full-text
 * over Thai-segmented text) fused with RRF, then an optional cross-encoder
 * rerank — exposed to an agent as a single `rag_search` tool.
 *
 * Thai has no spaces, so the lexical/BM25 side needs word segmentation; we use
 * the runtime's ICU `Intl.Segmenter` (no extra deps). The dense side (bge-m3)
 * needs no segmentation. This matches the 2026 best-practice for Thai retrieval:
 * hybrid → rerank.
 */
import { type Tool, defineTool } from '../../src/index'

/** Minimal structural type satisfied by a `pg` Pool/Client (avoids a hard dep). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}
export type Embedder = (text: string) => Promise<number[]> | number[]
/** Cross-encoder reranker: one relevance score per doc (higher = more relevant). */
export type Reranker = (query: string, docs: string[]) => Promise<number[]>

export interface RagDoc {
  id: string
  title: string
  body: string
}
export interface RagHit {
  id: string
  title: string
  snippet: string
  score: number
}

const SEGMENTER = new Intl.Segmenter('th', { granularity: 'word' })

/** Thai-aware tokenization (ICU): "อากาศดี" → "อากาศ ดี". Latin words pass through. */
export function segment(text: string): string {
  return [...SEGMENTER.segment(text)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment)
    .join(' ')
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

export interface HybridRagOptions {
  client: SqlClient
  embed: Embedder
  /** Embedding dimensions (must match the model, e.g. bge-m3 = 1024). */
  dimensions: number
  /** Optional cross-encoder reranker applied to the fused candidates. */
  rerank?: Reranker
  /** Reciprocal-rank-fusion constant. Default 60. */
  rrfK?: number
}

export class HybridRag {
  constructor(private readonly opts: HybridRagOptions) {}

  /** Create the extension, table (dense + sparse columns), and FTS index. */
  async init(): Promise<void> {
    const { client, dimensions } = this.opts
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
    await client.query(
      `CREATE TABLE IF NOT EXISTS documents (
         id text PRIMARY KEY,
         title text NOT NULL,
         body text NOT NULL,
         body_seg text NOT NULL,
         fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', body_seg)) STORED,
         embedding vector(${dimensions}) NOT NULL
       )`,
    )
    await client.query('CREATE INDEX IF NOT EXISTS documents_fts_idx ON documents USING gin (fts)')
  }

  /** Upsert documents: embed (dense) + store Thai-segmented text (sparse). */
  async ingest(docs: RagDoc[]): Promise<void> {
    for (const d of docs) {
      const embedding = toVectorLiteral([...(await this.opts.embed(`${d.title}\n${d.body}`))])
      await this.opts.client.query(
        `INSERT INTO documents (id, title, body, body_seg, embedding) VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, body = EXCLUDED.body,
           body_seg = EXCLUDED.body_seg, embedding = EXCLUDED.embedding`,
        [d.id, d.title, d.body, segment(`${d.title} ${d.body}`), embedding],
      )
    }
  }

  /**
   * Hybrid retrieve — dense (cosine) + sparse (FTS) fused with RRF in one query —
   * then optionally rerank the candidates with a cross-encoder.
   */
  async search(query: string, limit = 5, candidates = 20): Promise<RagHit[]> {
    const qvec = toVectorLiteral([...(await this.opts.embed(query))])
    const qseg = segment(query)
    const k = this.opts.rrfK ?? 60
    const fetch = this.opts.rerank ? limit * 4 : limit

    const { rows } = await this.opts.client.query(
      `WITH dense AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rnk
         FROM documents ORDER BY embedding <=> $1::vector LIMIT $3
       ),
       sparse AS (
         SELECT id, ROW_NUMBER() OVER (
                  ORDER BY ts_rank(fts, websearch_to_tsquery('simple', $2)) DESC) AS rnk
         FROM documents WHERE fts @@ websearch_to_tsquery('simple', $2) LIMIT $3
       ),
       fused AS (
         SELECT id, SUM(1.0 / ($4 + rnk)) AS rrf
         FROM (SELECT * FROM dense UNION ALL SELECT * FROM sparse) u
         GROUP BY id
       )
       SELECT d.id, d.title, d.body, f.rrf AS score
       FROM fused f JOIN documents d ON d.id = f.id
       ORDER BY f.rrf DESC LIMIT $5`,
      [qvec, qseg, candidates, k, fetch],
    )

    let hits: RagHit[] = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      snippet: String(r.body).slice(0, 200),
      score: Number(r.score),
    }))

    if (this.opts.rerank && hits.length > 0) {
      const scores = await this.opts.rerank(
        query,
        rows.map((r) => `${r.title}\n${r.body}`),
      )
      hits = hits
        .map((h, i) => ({ ...h, score: scores[i] ?? h.score }))
        .sort((a, b) => b.score - a.score)
    }
    return hits.slice(0, limit)
  }
}

/** Expose a HybridRag as a single `rag_search` tool for an agent. */
export function createRagSearchTool(rag: HybridRag): Tool {
  return defineTool<{ query: string }>({
    name: 'rag_search',
    description:
      'Search the Thai/English knowledge base (hybrid dense + keyword retrieval, reranked). Returns the most relevant passages with titles to cite.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look up' } },
      required: ['query'],
    },
    execute: async ({ query }) => {
      const results = await rag.search(query)
      return {
        results: results.map((h) => ({ title: h.title, snippet: h.snippet, score: h.score })),
      }
    },
  })
}
