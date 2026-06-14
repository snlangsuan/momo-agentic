/**
 * Observability (Layers 7 + 8) — the full event stream powers both the
 * Application (UI streaming) and Governance (metering). This shows every event
 * type, composing listeners with `combineHooks`, and tallying with `UsageTracker`.
 *
 * Run with:  bun run examples/observability.ts
 */
import { Agent, type AgentEvent, UsageTracker, combineHooks, defineTool } from '../src/index'
import { scriptModel } from './_support/mock-model'

const getWeather = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'weather',
  execute: ({ city }) => `sunny in ${city}`,
})

// 1. A UI/log listener that reacts to specific events.
const uiHook = {
  onEvent: (e: AgentEvent) => {
    switch (e.type) {
      case 'run_start':
        return console.log(`▶ start: "${e.input}"`)
      case 'thinking':
        return console.log(`  💭 ${e.text}`)
      case 'tool_call':
        return console.log(`  🔧 ${e.tool}(${JSON.stringify(e.args)})`)
      case 'tool_result':
        return console.log(`  ✅ ${e.tool} → ${JSON.stringify(e.result)}`)
      case 'usage':
        return console.log(`  📊 ${e.usage.totalTokens} tokens, tools=[${e.tools}]`)
      case 'run_end':
        return console.log(`■ end: "${e.output}"`)
    }
  },
}

// 2. A governance listener that accumulates usage across runs.
const tracker = new UsageTracker()

const agent = new Agent({
  model: scriptModel([
    {
      content: 'Let me check the weather.',
      toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Bangkok' } }],
      usage: { inputTokens: 20, outputTokens: 8 },
    },
    { content: 'It is sunny in Bangkok.', usage: { inputTokens: 25, outputTokens: 6 } },
  ]),
  tools: [getWeather],
  hooks: combineHooks(uiHook, tracker.hooks), // both listeners receive every event
})

await agent.run('weather in Bangkok?')
console.log('\nGovernance snapshot:', tracker.snapshot())
