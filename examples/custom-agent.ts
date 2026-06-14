/**
 * Custom agent — extend BaseAgent for a fully bespoke orchestration while still
 * plugging into the rest of the library (it gets `asTool()` for free, so other
 * agents can delegate to it; Layer 2 — Agent Internet).
 *
 * This toy agent answers from a fixed FAQ and otherwise says it doesn't know —
 * no model call at all. Anything implementing `run()` is a valid agent.
 *
 * Run with:  bun run examples/custom-agent.ts
 */
import {
  Agent,
  BaseAgent,
  type RunInput,
  type RunResult,
  emptyUsage,
  partsToText,
} from '../src/index'
import { scriptModel } from './_support/mock-model'

class FaqAgent extends BaseAgent {
  readonly name = 'faq'
  private readonly faq: Record<string, string>

  constructor(faq: Record<string, string>) {
    super()
    this.faq = faq
  }

  run(input: RunInput): Promise<RunResult> {
    const text = typeof input === 'string' ? input : partsToText(input)
    const hit = Object.entries(this.faq).find(([q]) => text.toLowerCase().includes(q))
    const output = hit ? hit[1] : "I don't have an answer for that."
    return Promise.resolve({
      output,
      returns: [],
      trace: [],
      messages: [
        { role: 'user', content: text },
        { role: 'assistant', content: output },
      ],
      steps: 0,
      usage: emptyUsage(),
      toolsInvoked: [],
      skillsUsed: [],
    })
  }
}

const faq = new FaqAgent({
  refund: 'Refunds are processed within 5 business days.',
  hours: 'We are open 9am–6pm, Mon–Fri.',
})

// Use it directly...
console.log('Direct:', (await faq.run('what are your hours?')).output)

// ...or let a coordinator agent delegate to it via asTool() (multi-agent).
const lead = new Agent({
  name: 'lead',
  model: scriptModel([
    { content: '', toolCalls: [{ id: 'd1', name: 'faq', arguments: { input: 'refund policy?' } }] },
    { content: 'Per our FAQ: refunds take up to 5 business days.' },
  ]),
  tools: [faq.asTool({ description: 'Answer customer FAQ questions' })],
})
console.log('Via lead:', (await lead.run('how long do refunds take?')).output)
