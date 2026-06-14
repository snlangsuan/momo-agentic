/**
 * Long-term semantic memory with Postgres + pgvector (Layer 6).
 *
 * Seeds Thai + English facts, then `searchFacts` retrieves the relevant one for a
 * Thai query — and the same memory plugs straight into an Agent (it injects the
 * relevant fact into the system prompt).
 *
 * Embedder: for real (multilingual, Thai-capable) results use `bge-m3` via Ollama
 * (`ollama pull bge-m3`); a toy hash embedder is the offline fallback.
 *
 * Env:
 *   DATABASE_URL   Postgres with the `vector` extension (required to actually run)
 *   EMBED          'hash' (default, toy) | 'ollama'
 *   OLLAMA_MODEL   default 'bge-m3'   OLLAMA_URL default http://localhost:11434
 *
 * Run:  DATABASE_URL=postgres://localhost/agentic EMBED=ollama bun run examples/pgvector-memory/index.ts
 */
import { Agent, type LanguageModel } from '../../src/index'
import { type Embedder, PgVectorMemory, type SqlClient } from './pgvector-memory'

// --- embedders ---
/** Toy deterministic embedder (NOT semantic) — lets the example run offline. */
function hashEmbed(dimensions = 64): Embedder {
  return (text: string) => {
    const v = new Array(dimensions).fill(0)
    for (let i = 0; i < text.length; i++) {
      v[i % dimensions] += text.charCodeAt(i)
    }
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  }
}

/** Real multilingual embeddings via Ollama (bge-m3 handles Thai well). */
function ollamaEmbed(model: string, baseUrl: string): Embedder {
  return async (text: string) => {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embeddings ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { embedding: number[] }
    return data.embedding
  }
}

const embed: Embedder =
  process.env.EMBED === 'ollama'
    ? ollamaEmbed(
        process.env.OLLAMA_MODEL ?? 'bge-m3',
        process.env.OLLAMA_URL ?? 'http://localhost:11434',
      )
    : hashEmbed()

// Probe once to learn the embedding dimensions (so the table matches the model).
const dimensions = (await embed('dimension probe')).length

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.log(`[dry run] no DATABASE_URL. Would create agent_facts with vector(${dimensions}).`)
  console.log('Start Postgres+pgvector, then set DATABASE_URL (and EMBED=ollama for Thai).')
  process.exit(0)
}

// `pg` is only needed at run time — dynamic import (non-literal specifier so TS
// doesn't require the types) keeps the example dep-light. Install with `bun add pg`.
const pgSpecifier = 'pg'
const { Pool } = (await import(pgSpecifier)) as {
  Pool: new (config: { connectionString: string }) => SqlClient & { end(): Promise<void> }
}
const pool = new Pool({ connectionString: dbUrl })
const memory = new PgVectorMemory({ client: pool, embed, dimensions, userId: 'demo' })

try {
  await memory.init()

  // Seed durable facts (Thai + English).
  await memory.rememberFact('แพ้อาหาร', 'แพ้ถั่วลิสง (allergic to peanuts)')
  await memory.rememberFact('งานอดิเรก', 'ปั่นจักรยานในวันหยุด')
  await memory.rememberFact('เมือง', 'อาศัยอยู่กรุงเทพฯ')

  // Semantic retrieval for a Thai question (real ranking needs EMBED=ollama).
  const hits = await memory.searchFacts('เมนูนี้มีถั่วไหม กินได้ไหม', { limit: 2 })
  console.log('searchFacts →', hits)

  // Plug the same memory into an agent: it injects the relevant fact.
  const model: LanguageModel = {
    id: 'mock',
    generate: ({ messages }) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? ''
      const fact = system.split('\n').find((l) => l.includes('แพ้')) ?? '(ไม่พบข้อมูล)'
      return Promise.resolve({ content: `รับทราบครับ ${fact.trim()}` })
    },
  }
  const agent = new Agent({ model, memory, factRecallLimit: 1 })
  const result = await agent.run('แนะนำเมนูให้หน่อย')
  console.log('\nagent →', result.output)
} finally {
  await pool.end()
}
