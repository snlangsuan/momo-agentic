/**
 * Cognition (Layer 5) — Planner: route a turn before the reasoning loop runs.
 * A planner can answer directly (`respond`), expose the full toolset (`auto`),
 * or narrow to specific tools (`use_tools`). The choice is emitted as a `plan`
 * event for observability.
 *
 * Run with:  bun run examples/planner.ts
 */
import { Agent, type Planner, defineTool } from '../src/index'
import { fnModel } from './_support/mock-model'

const getWeather = defineTool({
  name: 'get_weather',
  description: 'weather',
  execute: () => 'sunny',
})
const search = defineTool({ name: 'search', description: 'web search', execute: () => 'results' })

// A trivial keyword router. A real one might call a small/cheap LLM.
const planner: Planner = {
  name: 'keyword-router',
  plan: (input) => {
    if (input.includes('weather')) {
      return { mode: 'use_tools', tools: ['get_weather'], reason: 'weather intent' }
    }
    if (input.includes('search') || input.includes('news')) {
      return { mode: 'auto', reason: 'needs tools, let the model choose' }
    }
    return { mode: 'respond', reason: 'plain chat — no tools' }
  },
}

// The model just answers; we only care which tools the planner exposed to it.
const model = fnModel('mock:planner', () => ({ content: 'ok' }))

const agent = new Agent({
  model,
  tools: [getWeather, search],
  planner,
  hooks: {
    onEvent: (e) => {
      if (e.type === 'plan') console.log(`  🧭 plan=${e.mode}${e.reason ? ` (${e.reason})` : ''}`)
    },
  },
})

for (const q of ['what is the weather today?', 'any news?', 'hello there']) {
  console.log(`\n❓ ${q}`)
  await agent.run(q)
}
