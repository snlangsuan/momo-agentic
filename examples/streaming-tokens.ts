/**
 * Cognition (Layer 5) — token streaming. When a `LanguageModel` adapter implements
 * the optional `generateStream`, the agent emits a `token` event per text delta, so
 * a chat UI can render the answer as it is produced (instead of one final blob).
 * Adapters that don't stream fall back to `generate` transparently.
 *
 * Run with:  bun run examples/streaming-tokens.ts
 */
import { Agent, type LanguageModel } from '../src/index'

// A mock streaming model: it yields the answer word-by-word, then returns the full
// ModelResponse (with tool calls / usage). A real adapter maps a provider's SSE
// stream to these deltas.
const model: LanguageModel = {
  id: 'mock:stream',
  generate: () => Promise.resolve({ content: '' }), // fallback, unused here
  async *generateStream() {
    const text = 'Streaming lets the answer appear token by token.'
    for (const word of text.split(' ')) {
      yield { delta: `${word} ` }
    }
    return { content: text }
  },
}

const agent = new Agent({
  model,
  hooks: {
    onEvent: (e) => {
      if (e.type === 'token') process.stdout.write(e.delta) // render live
    },
  },
})

process.stdout.write('🤖 ')
const result = await agent.run('say something')
console.log(`\n\n(final output: "${result.output}")`)
