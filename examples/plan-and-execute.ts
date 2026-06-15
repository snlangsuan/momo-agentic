/**
 * Cognition (Layer 5) — PlanAndExecuteStrategy: plan the whole turn up front,
 * execute each step (each its own ReAct loop, so a step may use several tools),
 * then synthesize a final answer. Swap it in via the `strategy` option — the rest
 * of the Agent (tools, memory, hooks) is unchanged. This example also turns on
 * `replan`, so the remaining steps adapt to what actually happened.
 *
 * Run with:  bun run examples/plan-and-execute.ts
 */
import { Agent, PlanAndExecuteStrategy, defineTool } from '../src/index'
import { fnModel } from './_support/mock-model'

const searchFlights = defineTool({
  name: 'search_flights',
  description: 'find flights to a city',
  execute: () => 'TG921 BKK→NRT, 09:00 (฿18,000)',
})
const bookHotel = defineTool({
  name: 'book_hotel',
  description: 'book a hotel',
  execute: () => 'Booked: Tokyo Budget Inn, 3 nights',
})

// A mock model that drives every phase by inspecting each request:
//  - planning: the synthetic `create_plan` tool is offered → emit the initial plan.
//  - re-planning: the `revise_plan` tool is offered → once the flight price is
//    known the budget is tight, so swap the "5-star hotel" step for a budget one.
//  - execution: a step instruction arrives → call the matching tool, then report.
//  - synthesis: no tools offered → write the final answer.
const model = fnModel('mock:plan', ({ messages, tools }) => {
  if (tools.some((t) => t.name === 'create_plan')) {
    const steps = ['Find a flight to Tokyo', 'Book a 5-star hotel in Tokyo']
    return { content: '', toolCalls: [{ id: 'plan', name: 'create_plan', arguments: { steps } }] }
  }
  if (tools.some((t) => t.name === 'revise_plan')) {
    const flightKnown = messages.some((m) => m.content.includes('TG921'))
    const alreadyRevised = messages.some((m) => m.content.startsWith('Revised plan'))
    if (flightKnown && !alreadyRevised) {
      const steps = ['Book a budget hotel in Tokyo to stay on budget']
      return { content: '', toolCalls: [{ id: 'r', name: 'revise_plan', arguments: { steps } }] }
    }
    return { content: 'remaining plan still fine' } // decline → no change
  }
  const last = messages[messages.length - 1]
  if (last?.role === 'tool') return { content: `Done: ${last.content}` }
  if (last?.content.includes('flight')) {
    return { content: '', toolCalls: [{ id: 'f', name: 'search_flights', arguments: {} }] }
  }
  if (last?.content.includes('hotel')) {
    return { content: '', toolCalls: [{ id: 'h', name: 'book_hotel', arguments: {} }] }
  }
  return { content: 'Trip set: flight TG921 and a 3-night budget hotel in Tokyo.' }
})

const agent = new Agent({
  model,
  tools: [searchFlights, bookHotel],
  strategy: new PlanAndExecuteStrategy({ replan: true }),
  hooks: {
    onEvent: (e) => {
      if (e.type === 'plan')
        console.log(`📋 ${e.reason?.includes('revised') ? 're-plan' : 'plan'}:\n${e.reason}`)
      if (e.type === 'tool_call') console.log(`  🔧 ${e.tool}`)
    },
  },
})

const result = await agent.run('plan my trip to Tokyo')
console.log(`\n✅ ${result.output}`)
console.log(`   (${result.steps} model calls, tools: ${result.toolsInvoked.join(', ')})`)
