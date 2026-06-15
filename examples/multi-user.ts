/**
 * Memory (Layer 6) — multi-user / multi-thread: serve many users, each with many
 * threads, from ONE base agent. A `MemoryStore` hands out a scoped `Memory` per
 * `(userId, threadId)`: conversation is isolated per thread, while long-term facts
 * are shared across a user's threads. `agent.withMemory(...)` forks a thin agent
 * bound to that scope (the agent is stateless, so this is cheap).
 *
 * Run with:  bun run examples/multi-user.ts
 */
import { Agent, MemoryStore } from '../src/index'
import { fnModel } from './_support/mock-model'

// Trivial model: echoes the latest user message so we can see per-thread history.
const model = fnModel('mock:multiuser', ({ messages }) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  return { content: `ack: ${lastUser?.content ?? ''}` }
})

const store = new MemoryStore()
const base = new Agent({ model })
const agentFor = (userId: string, threadId: string) =>
  base.withMemory(store.for({ userId, threadId }))

// Two users, each with two threads — all routed through the one base agent.
await agentFor('alice', 'work').run('book a meeting')
await agentFor('alice', 'travel').run('find me flights')
await agentFor('bob', 'work').run('reset my password')

const scopes: Array<[string, string]> = [
  ['alice', 'work'],
  ['alice', 'travel'],
  ['bob', 'work'],
]
for (const [userId, threadId] of scopes) {
  const history = await store.for({ userId, threadId }).loadHistory()
  console.log(`\n👤 ${userId} / 🧵 ${threadId}`)
  for (const m of history) console.log(`  ${m.role}: ${m.content}`)
}

// Long-term facts: shared across a user's threads, isolated between users.
await store.for({ userId: 'alice', threadId: 'work' }).rememberFact?.('name', 'Alice')
console.log(
  '\nalice/travel recalls:',
  store.for({ userId: 'alice', threadId: 'travel' }).recallFacts?.(),
)
console.log('bob/work recalls:   ', store.for({ userId: 'bob', threadId: 'work' }).recallFacts?.())
