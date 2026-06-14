/**
 * Skills example (Layer 4): bundle tools + an instruction fragment into a named
 * capability. The agent exposes every skill's tools and injects each skill's
 * instruction into the system prompt; `result.skillsUsed` reports which skills'
 * tools were actually invoked (useful for metering/governance).
 *
 * Run with:  bun run examples/skills.ts
 */
import {
  Agent,
  type LanguageModel,
  defineSkill,
  defineSkillFromManifest,
  defineTool,
} from '../src/index'

// (a) Programmatic skill: a bundle of tools + guidance.
const weather = defineSkill({
  name: 'weather',
  description: 'Current weather lookups',
  instruction: 'For any weather question, call get_weather and report the temperature in °C.',
  tools: [
    defineTool<{ city: string }>({
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: ({ city }) => `It is 32°C and sunny in ${city}.`,
    }),
  ],
  keywords: ['weather', 'temperature', 'forecast'],
})

// (b) Manifest-driven skill: prose/metadata live in a `skill.md` string.
const SEARCH_MANIFEST = `---
name: web_search
description: Search the web for current information
credit_cost: 3
keywords: [search, news, latest]
---
Use the search tool for anything current (news, prices, latest releases). Cite sources.`

const search = defineSkillFromManifest(SEARCH_MANIFEST, [
  defineTool<{ query: string }>({
    name: 'search',
    description: 'Search the web',
    execute: ({ query }) => `Top result for "${query}": …`,
  }),
])

// A mock model that uses the weather skill's tool, then answers.
let turn = 0
const model: LanguageModel = {
  id: 'mock-model',
  generate: () => {
    turn++
    return Promise.resolve(
      turn === 1
        ? {
            content: '',
            toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Bangkok' } }],
          }
        : { content: 'It is 32°C and sunny in Bangkok.' },
    )
  },
}

const agent = new Agent({ model, skills: [weather, search] })

const result = await agent.run('What is the weather in Bangkok?')
console.log('Output:', result.output)
console.log('Skills used:', result.skillsUsed) // → ['weather']
