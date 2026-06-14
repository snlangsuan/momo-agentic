/**
 * Basic example: an agent with one tool, memory, and observability hooks.
 *
 * Run with:  bun run examples/basic.ts
 *
 * Swap `mockModel` for a real {@link LanguageModel} adapter (e.g. one calling
 * the Claude API) to make this talk to an actual LLM.
 */
import { Agent, InMemoryMemory, type LanguageModel, UsageTracker, defineTool } from '../src/index'

// Layer 4 — Tooling
const getWeather = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  execute: ({ city }) => `It is 32°C and sunny in ${city}.`,
})

// Layer 5 — Cognition: a stand-in model. Replace with a real provider adapter.
let turn = 0
const mockModel: LanguageModel = {
  id: 'mock-model',
  generate: () => {
    turn++
    if (turn === 1) {
      return Promise.resolve({
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Bangkok' } }],
        usage: { inputTokens: 20, outputTokens: 8 },
      })
    }
    return Promise.resolve({
      content: 'The weather in Bangkok is 32°C and sunny.',
      usage: { inputTokens: 30, outputTokens: 12 },
    })
  },
}

const tracker = new UsageTracker() // Layer 8 — Governance

const agent = new Agent({
  name: 'weather-bot',
  model: mockModel,
  persona: 'You are a friendly weather assistant.',
  tools: [getWeather],
  memory: new InMemoryMemory(), // Layer 6 — Memory
  hooks: { onEvent: (e) => console.log(`  • ${e.type}${'tool' in e ? `: ${e.tool}` : ''}`) }, // Layer 7
})

const result = await agent.run('What is the weather in Bangkok?')
console.log('\nOutput:', result.output)
console.log('Steps:', result.steps, '| Tokens:', result.usage.totalTokens)
// Run a second turn through governance.
const t2 = new Agent({ model: mockModel, hooks: tracker.hooks })
turn = 1
await t2.run('and tomorrow?')
console.log('Usage snapshot:', tracker.snapshot())
