/**
 * Cognition (Layer 5) — custom ReasoningStrategy: replace the default ReAct loop.
 * This one runs a single model pass with no tool round-trips (useful for a
 * "fast path" agent). Implement the same interface for plan-and-execute,
 * reflexion, tree-of-thought, etc.
 *
 * Run with:  bun run examples/custom-strategy.ts
 */
import {
  Agent,
  type ReasoningInput,
  type ReasoningResult,
  type ReasoningStrategy,
  addUsage,
  emptyUsage,
} from '../src/index'
import { scriptModel } from './_support/mock-model'

class SinglePassStrategy implements ReasoningStrategy {
  readonly name = 'single-pass'

  async run(input: ReasoningInput): Promise<ReasoningResult> {
    const usage = emptyUsage()
    const response = await input.model.generate({
      messages: input.messages,
      tools: [], // this strategy never offers tools
      signal: input.signal,
    })
    addUsage(usage, response.usage)
    input.messages.push({ role: 'assistant', content: response.content })
    return {
      output: response.content,
      returns: [],
      trace: [{ step: 1, usage, text: response.content, tools: [] }],
      messages: input.messages,
      steps: 1,
      usage,
      toolsInvoked: [],
    }
  }
}

const model = scriptModel([
  { content: 'A quick one-shot answer.', usage: { inputTokens: 10, outputTokens: 4 } },
])

const agent = new Agent({ model, strategy: new SinglePassStrategy() })
const result = await agent.run('hello')
console.log('Output:', result.output)
console.log('Steps:', result.steps, '| Tokens:', result.usage.totalTokens)
