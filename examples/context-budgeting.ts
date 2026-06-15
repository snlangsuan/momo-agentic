/**
 * Context-window budgeting. `contextLimit` trims the transcript to fit a token
 * budget before each model turn — keeping the system message and the latest turn,
 * dropping the oldest middle turns first — and emits a `context_trimmed` event.
 * Plug a real `tokenCounter` for precision; the default is a ~4-chars/token guess.
 *
 * Run with:  bun run examples/context-budgeting.ts
 */
import { Agent, type Message } from '../src/index'
import { InMemoryMemory } from '../src/memory/in-memory'
import { scriptModel } from './_support/mock-model'

// A long prior conversation already in memory.
const history: Message[] = [
  { role: 'user', content: 'tell me about Thailand' },
  { role: 'assistant', content: 'Thailand is in Southeast Asia…' },
  { role: 'user', content: 'and its capital?' },
  { role: 'assistant', content: 'Bangkok.' },
  { role: 'user', content: 'population?' },
  { role: 'assistant', content: 'About 70 million.' },
]

const agent = new Agent({
  model: scriptModel([{ content: 'Sure!' }]),
  memory: new InMemoryMemory({ messages: history }),
  contextLimit: 3, // keep ~3 messages' worth; oldest turns get trimmed
  tokenCounter: { count: () => 1 }, // 1 token/message here, for a clear demo
  instructions: 'You are concise.',
  hooks: {
    onEvent: (e) => {
      if (e.type === 'context_trimmed') {
        console.log(`✂️  trimmed ${e.dropped} old message(s); ${e.tokens} tokens remain`)
      }
    },
  },
})

await agent.run('anything new?')
