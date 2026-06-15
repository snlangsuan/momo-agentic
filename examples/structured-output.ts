/**
 * Structured / typed output. Set `responseSchema` and the agent exposes a synthetic
 * `respond` tool (its parameters ARE your JSON Schema), tells the model to answer
 * through it, and returns the validated object on `result.object` (its JSON on
 * `result.output`). Pass `parse` to plug a real validator (zod/ajv).
 *
 * Run with:  bun run examples/structured-output.ts
 */
import { Agent } from '../src/index'
import { scriptModel } from './_support/mock-model'

const schema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    celsius: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['city', 'celsius', 'summary'],
}

// The mock model delivers its answer by calling the `respond` tool with an object.
const model = scriptModel([
  {
    content: '',
    toolCalls: [
      {
        id: 'r',
        name: 'respond',
        arguments: { city: 'Bangkok', celsius: 34, summary: 'Hot and humid.' },
      },
    ],
  },
])

const agent = new Agent({ model, responseSchema: { schema } })
const result = await agent.run('weather in Bangkok?')

console.log('object:', result.object) // ← a real JS object, typed by your schema
console.log('output:', result.output) // ← JSON rendering for display/logging
