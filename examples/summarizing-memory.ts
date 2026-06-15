/**
 * Memory (Layer 6) — bounding a long conversation with `SummarizingMemory`.
 *
 * Two knobs, NOT one: `threshold` (when to start summarizing) and `keepRecent`
 * (how many newest messages stay verbatim). Once the transcript passes the
 * threshold, everything OLDER than the last `keepRecent` is compressed into a
 * single summary system-message; the recent tail is kept as-is. So old turns are
 * NOT dropped — they're folded into a summary. (For a hard token cap that *drops*
 * old turns instead, see `contextLimit` in examples/context-budgeting.ts.)
 *
 * Run with:  bun run examples/summarizing-memory.ts
 */
import { InMemoryMemory, type Message, type Summarizer, SummarizingMemory } from '../src/index'

const THRESHOLD = 6
const KEEP_RECENT = 4

// A real summarizer would call an LLM; here we just list the older questions.
const summarizer: Summarizer = {
  summarize: (older: Message[], previous?: string) => {
    console.log(
      `  🧠 summarize() called with ${older.length} older messages${previous ? ' (incremental)' : ''}`,
    )
    const asked = older.filter((m) => m.role === 'user').map((m) => m.content)
    return `Earlier, the user asked about: ${asked.join('; ')}.`
  },
}

const store = new InMemoryMemory()
const memory = new SummarizingMemory(store, {
  summarizer,
  threshold: THRESHOLD,
  keepRecent: KEEP_RECENT,
})

const addTurn = async (i: number) => {
  await memory.appendMessage({ role: 'user', content: `question ${i}` })
  await memory.appendMessage({ role: 'assistant', content: `answer ${i}` })
}

const show = async (label: string) => {
  const view = await memory.loadHistory() // what the agent would feed the model
  console.log(`\n${label}: stored=${store.loadHistory().length} raw, model sees ${view.length}:`)
  for (const m of view) console.log(`  ${m.role}: ${m.content}`)
}

// Below the threshold → the model sees the full transcript, verbatim.
await addTurn(1)
await addTurn(2)
await show(`after 2 turns (4 ≤ threshold ${THRESHOLD})`)

// Past the threshold → older turns fold into one summary, last keepRecent stay raw.
await addTurn(3)
await addTurn(4)
await addTurn(5)
await show(`after 5 turns (10 > threshold ${THRESHOLD}, keepRecent ${KEEP_RECENT})`)
