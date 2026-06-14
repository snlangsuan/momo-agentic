/**
 * Multi-agent example (Layer 2 — Agent Internet): a lead agent delegates to a
 * specialist researcher agent by exposing it as a tool.
 *
 * Run with:  bun run examples/multi-agent.ts
 */
import { Agent, type LanguageModel, agentAsTool, defineTool } from '../src/index'

// A specialist agent with its own tool.
const search = defineTool({
  name: 'search',
  description: 'Search the web',
  execute: () => 'Bangkok is the capital of Thailand.',
})
let rTurn = 0
const researcherModel: LanguageModel = {
  id: 'researcher-model',
  generate: () => {
    rTurn++
    return Promise.resolve(
      rTurn === 1
        ? { content: '', toolCalls: [{ id: 's1', name: 'search', arguments: { q: 'capital' } }] }
        : { content: 'The capital of Thailand is Bangkok.' },
    )
  },
}
const researcher = new Agent({ name: 'researcher', model: researcherModel, tools: [search] })

// A lead agent that can hand off to the researcher.
let lTurn = 0
const leadModel: LanguageModel = {
  id: 'lead-model',
  generate: () => {
    lTurn++
    return Promise.resolve(
      lTurn === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'd1', name: 'researcher', arguments: { input: 'capital of Thailand?' } },
            ],
          }
        : { content: 'I checked with my researcher — the answer is Bangkok.' },
    )
  },
}
const lead = new Agent({
  name: 'lead',
  model: leadModel,
  tools: [
    agentAsTool(researcher, { description: 'Delegate research questions to the researcher agent' }),
  ],
})

const result = await lead.run('What is the capital of Thailand?')
console.log('Output:', result.output)
console.log('Tools invoked by lead:', result.toolsInvoked)
