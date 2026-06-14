/**
 * Robustness — `AgentError` (tagged with the failing stage), `AbortSignal`
 * propagation, and the `maxSteps` runaway-loop guard.
 *
 * Run with:  bun run examples/errors-and-abort.ts
 */
import { Agent, AgentError, type LanguageModel, defineTool } from '../src/index'
import { scriptModel } from './_support/mock-model'

// 1. Errors surface as AgentError with the stage that failed.
const failingModel: LanguageModel = {
  id: 'mock:failing',
  generate: () => Promise.reject(new Error('provider exploded')),
}
try {
  await new Agent({ model: failingModel }).run('hi')
} catch (err) {
  if (err instanceof AgentError) {
    console.log(`Caught AgentError @ stage="${err.stage}": ${err.message}`)
  }
}

// 2. AbortSignal is propagated to model + tools; honor it to cancel work.
const abortModel: LanguageModel = {
  id: 'mock:abort',
  generate: ({ signal }) => {
    if (signal?.aborted) return Promise.reject(new Error('aborted by caller'))
    return Promise.resolve({ content: 'should not get here' })
  },
}
const controller = new AbortController()
controller.abort() // pretend the user cancelled
try {
  await new Agent({ model: abortModel }).run('do work', { signal: controller.signal })
} catch (err) {
  console.log('Abort propagated:', err instanceof AgentError ? err.message : String(err))
}

// 3. maxSteps caps the reason→act loop even if the model never stops calling tools.
const loopTool = defineTool({ name: 'again', description: 'loops', execute: () => 'keep going' })
const loopModel = scriptModel(
  Array.from({ length: 10 }, (_, i) => ({
    content: '',
    toolCalls: [{ id: `c${i}`, name: 'again', arguments: { n: i } }],
  })),
)
const result = await new Agent({ model: loopModel, tools: [loopTool], maxSteps: 3 }).run(
  'loop forever',
)
console.log(`maxSteps guard: stopped after ${result.steps} steps`)
