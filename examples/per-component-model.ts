/**
 * Cognition (Layer 5) — using a DIFFERENT model per component of one turn.
 *
 * A single turn touches several "thinking" jobs. They don't all need your most
 * capable (and most expensive) model. Here `PlanAndExecuteStrategy` runs:
 *   - planning + re-planning  → a cheap, fast model (`planningModel`)
 *   - step execution + final synthesis → the Agent's main model
 *
 * Each `step` / `token` event — and each `result.trace` entry — carries the
 * `model` id that produced it, so logging can attribute every record to the
 * model behind it (printed below from the hook stream).
 *
 * Other per-component splits already available in the library:
 *   - multi-agent: each `Agent` has its own `model`, wired with `agentAsTool`
 *   - summarization: `createModelSummarizer(cheapModel)` for `SummarizingMemory`
 *   - a single tool can call its own model internally (see tool-internal-llm.ts)
 *
 * Run with:  bun run examples/per-component-model.ts
 */
import { Agent, type LanguageModel, PlanAndExecuteStrategy, defineTool } from '../src/index'
import { fnModel } from './_support/mock-model'

const lookup = defineTool({
  name: 'lookup',
  description: 'look something up',
  execute: () => 'result: 42',
})

// Cheap model: only ever asked to plan / re-plan (it sees create_plan / revise_plan).
const planningModel: LanguageModel = fnModel('cheap:planner', () => {
  const steps = ['Look up the value', 'Report it']
  return {
    content: '',
    toolCalls: [{ id: 'p', name: 'create_plan', arguments: { steps } }],
    usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
  }
})

// Capable model: executes each step and writes the final answer.
const mainModel: LanguageModel = fnModel('smart:main', ({ messages, tools }) => {
  const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
  const last = messages.at(-1)
  if (tools.length === 0) return { content: 'The value is 42.', usage } // synthesis
  if (last?.role === 'tool') return { content: `Done: ${last.content}`, usage } // step report
  return { content: '', toolCalls: [{ id: 'l', name: 'lookup', arguments: {} }], usage } // step → tool
})

const agent = new Agent({
  model: mainModel, // the main reasoning model
  tools: [lookup],
  strategy: new PlanAndExecuteStrategy({ planningModel }), // planning offloaded to the cheap one
  hooks: {
    // Each `step` event carries the model id AND that call's token usage — enough
    // for a log line to say exactly which model ran and how much it consumed.
    onEvent: (e) => {
      if (e.type === 'step') {
        console.log(
          `  step ${e.step}: model=${e.model} in=${e.usage.inputTokens} out=${e.usage.outputTokens}`,
        )
      }
    },
  },
})

const result = await agent.run('what is the value?')
console.log(`\n✅ ${result.output}`)

// `result.usageByModel` rolls the per-step (model, usage) up for you — no manual
// reduction needed. (Converting tokens → money is left to the caller.)
console.log('\nusage by model:')
for (const [model, u] of Object.entries(result.usageByModel)) {
  console.log(`  ${model}: input=${u.inputTokens} tokens, output=${u.outputTokens} tokens`)
}
