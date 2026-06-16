/**
 * Durable / resumable runs (Layer 8 — Governance / reliability).
 *
 * A `RunStore` checkpoints a run after every step, so a process that dies
 * mid-loop can RESUME from the last checkpoint instead of redoing everything.
 * This example simulates a crash: the first attempt fails on the second model
 * call (after a tool already ran); the second attempt resumes and finishes —
 * WITHOUT re-running the tool, since its result is already in the saved
 * transcript. (At-least-once: durable tools should be idempotent.)
 *
 * Run with:  bun run examples/durable-run.ts
 */
import { Agent, InMemoryRunStore, type LanguageModel, defineTool } from '../src/index'

let toolRuns = 0
const charge = defineTool<{ amount: number }>({
  name: 'charge_card',
  description: 'Charge the customer (an expensive side effect we must not repeat).',
  parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
  execute: ({ amount }) => {
    toolRuns++
    console.log(`  💳 charged $${amount} (tool run #${toolRuns})`)
    return { charged: amount, ok: true }
  },
})

const store = new InMemoryRunStore()
const RUN_ID = 'order-1001'

// Attempt 1: the model asks to charge, then "crashes" on the next call.
let call = 0
const crashing: LanguageModel = {
  id: 'flaky',
  generate: () => {
    call++
    if (call === 1) {
      return Promise.resolve({
        content: '',
        toolCalls: [{ id: '1', name: 'charge_card', arguments: { amount: 49 } }],
      })
    }
    return Promise.reject(new Error('💥 process crashed'))
  },
}

console.log('▶️  attempt 1 (will crash after the charge):')
try {
  await new Agent({ model: crashing, tools: [charge], runStore: store }).run('place my order', {
    runId: RUN_ID,
  })
} catch (err) {
  console.log(
    `  ⚠️  ${(err as Error).message} — checkpoint saved at step ${store.load(RUN_ID)?.step}`,
  )
}

// Attempt 2: a fresh process/model resumes from the checkpoint and finishes.
const finishing: LanguageModel = {
  id: 'recovered',
  generate: () => Promise.resolve({ content: 'Your order is confirmed — $49 charged.' }),
}

console.log('\n▶️  attempt 2 (resume):')
const result = await new Agent({ model: finishing, tools: [charge], runStore: store }).run(
  'place my order',
  { runId: RUN_ID, resume: true },
)

console.log(`  ✅ ${result.output}`)
console.log(
  `\n📊 card charged ${toolRuns}× (not twice!), checkpoint cleared: ${store.load(RUN_ID) === undefined}`,
)
