/**
 * SQL-backed persistence (`momo-agentic/postgres` — same shape for `/mysql`).
 *
 * `PostgresMemory` / `PostgresRunStore` / `PostgresModelCache` implement the
 * persistence ports over a `pg` Pool; `ensureSchema(pool)` creates the `momo_*`
 * tables on boot. In production you pass `new Pool({ connectionString })`; to keep
 * THIS file runnable with no database, it uses a tiny in-process stand-in for the
 * handful of SQL statements the Memory adapter issues.
 *
 * Run with:  bun run examples/sql-backends.ts
 */
import type { Pool } from 'pg'
import { Agent, type LanguageModel } from '../src/index'
import { PostgresMemory, ensureSchema } from '../src/postgres/index'

// --- a minimal in-process Postgres (swap for a real `pg` Pool) --------------
const messages = new Map<string, unknown[]>()
const facts = new Map<string, Map<string, string>>()
let created = 0
const pool = {
  query(text: string, p: unknown[] = []) {
    const s = text.toLowerCase()
    const rows = (r: unknown[] = []) => Promise.resolve({ rows: r })
    if (s.startsWith('create')) {
      created++
      return rows()
    }
    if (s.startsWith('insert') && s.includes('momo_messages')) {
      const list = messages.get(p[0] as string) ?? []
      list.push(JSON.parse(p[1] as string))
      messages.set(p[0] as string, list)
      return rows()
    }
    if (s.includes('from momo_messages')) {
      return rows((messages.get(p[0] as string) ?? []).map((m) => ({ message: m })))
    }
    if (s.startsWith('insert') && s.includes('momo_facts')) {
      const m = facts.get(p[0] as string) ?? new Map<string, string>()
      m.set(p[1] as string, p[2] as string)
      facts.set(p[0] as string, m)
      return rows()
    }
    if (s.includes('from momo_facts')) {
      const m = facts.get(p[0] as string) ?? new Map<string, string>()
      return rows([...m.entries()].map(([key, value]) => ({ key, value })))
    }
    return rows()
  },
} as unknown as Pool

// --- boot: create tables, then use it like any Memory -----------------------
await ensureSchema(pool)
console.log(`🧱 ensureSchema → ${created} CREATE statements run`)

const memory = new PostgresMemory(pool, `user:${'u1'}`)
const model: LanguageModel = {
  id: 'echo',
  generate: ({ messages: m }) =>
    Promise.resolve({ content: `noted (turn ${m.filter((x) => x.role === 'user').length})` }),
}
const agent = new Agent({ model, memory, rememberFacts: true })

await agent.run('hi, I am Decimo')
await memory.rememberFact?.('name', 'Decimo')
await agent.run('what do you know about me?')

console.log('\n🐘 conversation (momo_messages):')
for (const msg of await memory.loadHistory()) console.log(`   ${msg.role}: ${msg.content}`)
console.log('\n🗃️  facts (momo_facts):', await memory.recallFacts?.())
