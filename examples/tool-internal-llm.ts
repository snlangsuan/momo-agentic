/**
 * A `directReturn` tool that calls an LLM INTERNALLY (Pattern A: capture a model).
 *
 * The tool generates text with its own `model.generate(...)`. That internal call
 * is an implementation detail — its prompt/response never touch the conversation:
 * the agent only persists the user's turn and the tool's final return value. This
 * keeps history clean and is the simplest way to "gen text inside a tool" without
 * any `this.generate` plumbing.
 *
 * Run with:  bun run examples/tool-internal-llm.ts
 */
import { Agent, InMemoryMemory, type LanguageModel, defineTool } from '../src/index'
import { scriptModel } from './_support/mock-model'

// The "writer" LLM the tool uses internally. It records the prompt it received so
// we can later prove that prompt stayed out of the conversation history.
let internalPrompt = ''
const writerModel: LanguageModel = {
  id: 'mock:writer',
  generate: ({ messages }) => {
    internalPrompt = messages.at(-1)?.content ?? ''
    return Promise.resolve({
      content: 'Subject: Team offsite\n\nHi team — details to follow. Thanks!',
    })
  },
}

// Pattern A: the model is captured in the tool's closure; calling it is internal.
const draftEmail = defineTool<{ topic: string }>({
  name: 'draft_email',
  description: 'draft an email about a topic',
  directReturn: true,
  parameters: {
    type: 'object',
    properties: { topic: { type: 'string' } },
    required: ['topic'],
  },
  execute: async ({ topic }, ctx) => {
    const r = await writerModel.generate({
      messages: [{ role: 'user', content: `Draft a short email about: ${topic}` }],
      tools: [],
      signal: ctx.signal, // respect the run's abort/timeout
    })
    return { message: r.content } // ← this becomes the persisted assistant turn
  },
})

const memory = new InMemoryMemory()
const agent = new Agent({
  // The agent's own model just decides to call the tool; the tool does the writing.
  model: scriptModel([
    {
      content: '',
      toolCalls: [{ id: 'd', name: 'draft_email', arguments: { topic: 'the team offsite' } }],
    },
  ]),
  memory,
  tools: [draftEmail],
})

const result = await agent.run('Write me an email about the team offsite.')
console.log('final output (the drafted email):')
console.log(result.output)

console.log('\n--- conversation history that got persisted ---')
for (const m of memory.loadHistory()) {
  console.log(`  ${m.role}: ${m.content.replace(/\n/g, ' ⏎ ')}`)
}

const leaked = memory.loadHistory().some((m) => m.content.includes('Draft a short email about'))
console.log('\ninternal prompt the tool sent to the writer LLM:')
console.log(' ', internalPrompt)
console.log('is that internal prompt in the conversation history?', leaked) // → false
