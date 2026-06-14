/**
 * Tooling (Layer 4): the three ways to author a tool, `directReturn`, and the
 * ToolRegistry.
 *
 * Run with:  bun run examples/tools.ts
 */
import {
  Agent,
  BaseTool,
  type Tool,
  type ToolContext,
  ToolRegistry,
  defineTool,
} from '../src/index'
import { scriptModel } from './_support/mock-model'

// (a) defineTool — typed functional helper. Non-string returns are JSON-serialized.
const add = defineTool<{ a: number; b: number }>({
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: ({ a, b }) => a + b,
})

// (b) BaseTool — prototype class, good for stateful tools / dependency injection.
class CounterTool extends BaseTool {
  readonly name = 'counter'
  readonly description = 'Increment and return an internal counter'
  private n = 0
  execute(): number {
    this.n += 1
    return this.n
  }
}

// (c) plain object — full control / adapters.
const ping: Tool = {
  name: 'ping',
  description: 'Returns pong',
  parameters: { type: 'object', properties: {} },
  execute: (_args: Record<string, unknown>, ctx: ToolContext) => `pong from ${ctx.agentName}`,
}

// directReturn — the tool's result becomes the final answer (loop exits early).
const finalAnswer = defineTool<{ message: string }>({
  name: 'final_answer',
  description: 'Deliver the final answer to the user',
  directReturn: true,
  execute: ({ message }) => ({ message }),
})

// A ToolRegistry collects tools by name (last registration wins).
const registry = new ToolRegistry().register(add, new CounterTool(), ping, finalAnswer)
console.log(
  'Registered tools:',
  registry.list().map((t) => t.name),
)

// The model calls `add`, then short-circuits with `final_answer`.
const model = scriptModel([
  { content: '', toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 2, b: 3 } }] },
  {
    content: '',
    toolCalls: [{ id: 'c2', name: 'final_answer', arguments: { message: '2 + 3 = 5' } }],
  },
])

const agent = new Agent({ model, tools: registry.list() })
const result = await agent.run('add 2 and 3')
console.log('Output:', result.output) // → "2 + 3 = 5" (from directReturn)
console.log('Tools invoked:', result.toolsInvoked)
