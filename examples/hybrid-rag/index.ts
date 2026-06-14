/**
 * Thai hybrid-RAG knowledge base wired into an agent (Layer 3/4).
 *
 * Ingests Thai docs, runs hybrid (dense + keyword) retrieval with RRF + optional
 * rerank, and exposes it as a `rag_search` tool the agent calls to answer with
 * citations.
 *
 * Env:
 *   DATABASE_URL   Postgres with the `vector` extension (required to run)
 *   EMBED          'hash' (toy, offline) | 'ollama'    OLLAMA_MODEL=bge-m3
 *   RERANK         unset (none) | 'tei'  RERANK_URL=http://localhost:8080  (bge-reranker-v2-m3)
 *
 * Run:  DATABASE_URL=... EMBED=ollama RERANK=tei bun run examples/hybrid-rag/index.ts "ลาพักร้อนได้กี่วัน"
 */
import { Agent, type LanguageModel, type Message } from '../../src/index'
import {
  type Embedder,
  HybridRag,
  type Reranker,
  type SqlClient,
  createRagSearchTool,
} from './hybrid-rag'

function hashEmbed(dimensions = 64): Embedder {
  return (text) => {
    const v = new Array(dimensions).fill(0)
    for (let i = 0; i < text.length; i++) v[i % dimensions] += text.charCodeAt(i)
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  }
}
function ollamaEmbed(model: string, baseUrl: string): Embedder {
  return async (text) => {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embeddings ${res.status}`)
    return ((await res.json()) as { embedding: number[] }).embedding
  }
}
/** bge-reranker-v2-m3 via HuggingFace Text Embeddings Inference (`/rerank`). */
function teiReranker(url: string): Reranker {
  return async (query, docs) => {
    const res = await fetch(`${url}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, texts: docs }),
    })
    const ranked = (await res.json()) as Array<{ index: number; score: number }>
    const scores = new Array(docs.length).fill(0)
    for (const r of ranked) scores[r.index] = r.score
    return scores
  }
}

const embed: Embedder =
  process.env.EMBED === 'ollama'
    ? ollamaEmbed(
        process.env.OLLAMA_MODEL ?? 'bge-m3',
        process.env.OLLAMA_URL ?? 'http://localhost:11434',
      )
    : hashEmbed()
const rerank: Reranker | undefined =
  process.env.RERANK === 'tei'
    ? teiReranker(process.env.RERANK_URL ?? 'http://localhost:8080')
    : undefined

const dimensions = (await embed('dimension probe')).length

const DOCS = [
  {
    id: 'hr-leave',
    title: 'นโยบายการลา',
    body: 'พนักงานมีสิทธิ์ลาพักร้อนปีละ 10 วัน และลาป่วยได้ 30 วันต่อปี ยื่นผ่านระบบ HR',
  },
  {
    id: 'hr-headcount',
    title: 'การขอรับพนักงานเพิ่ม',
    body: 'หัวหน้าแผนกกรอกฟอร์ม Headcount Request เพื่อขออัตรากำลังเพิ่ม รออนุมัติจากฝ่ายบุคคล',
  },
  {
    id: 'it-vpn',
    title: 'การใช้งาน VPN',
    body: 'เชื่อมต่อ VPN ด้วยบัญชีพนักงาน หากรหัสผ่านหมดอายุให้รีเซ็ตที่พอร์ทัล IT',
  },
  {
    id: 'fin-reim',
    title: 'การเบิกค่าใช้จ่าย',
    body: 'แนบใบเสร็จและกรอกฟอร์มเบิกค่าใช้จ่าย ค่าเดินทางเบิกได้ตามจริงไม่เกินวงเงินที่กำหนด',
  },
]

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.log(`[dry run] no DATABASE_URL. Would build documents(vector(${dimensions}) + tsvector).`)
  console.log('Thai segmentation works offline — e.g. "ลาพักร้อนกี่วัน" →', '"ลา พักร้อน กี่ วัน"')
  process.exit(0)
}

const pgSpecifier = 'pg'
const { Pool } = (await import(pgSpecifier)) as {
  Pool: new (c: { connectionString: string }) => SqlClient & { end(): Promise<void> }
}
const pool = new Pool({ connectionString: dbUrl })
const rag = new HybridRag({ client: pool, embed, dimensions, rerank })

try {
  await rag.init()
  await rag.ingest(DOCS)

  const query = process.argv[2] ?? 'ลาพักร้อนได้ปีละกี่วัน'
  console.log(`\n🔎 hybrid search: "${query}"`)
  console.table(await rag.search(query, 3))

  // The agent calls rag_search, then answers citing the titles.
  const tool = createRagSearchTool(rag)
  let turn = 0
  const model: LanguageModel = {
    id: 'mock',
    generate: ({ messages }: { messages: Message[] }) => {
      turn++
      if (turn === 1) {
        const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
        return Promise.resolve({
          content: '',
          toolCalls: [{ id: 'r1', name: 'rag_search', arguments: { query: userText } }],
        })
      }
      const toolMsg = [...messages].reverse().find((m) => m.role === 'tool')?.content ?? '{}'
      const { results = [] } = JSON.parse(toolMsg) as {
        results?: Array<{ title: string; snippet: string }>
      }
      const top = results[0]
      return Promise.resolve({
        content: top ? `${top.snippet} (อ้างอิง: ${top.title})` : 'ไม่พบข้อมูลในคลังความรู้ครับ',
      })
    },
  }
  const agent = new Agent({
    model,
    tools: [tool],
    instructions: 'ตอบจากคลังความรู้และอ้างอิงชื่อเอกสารเสมอ',
  })
  const result = await agent.run(query)
  console.log(`\n🤖 ${result.output}`)
} finally {
  await pool.end()
}
