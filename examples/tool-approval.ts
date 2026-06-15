/**
 * Tooling (Layer 4) — human-in-the-loop tool approval. A tool flagged
 * `requiresApproval: true` is routed through the injected `ToolApprover` before it
 * runs. The approver may allow it, deny it (the model gets an error back), or edit
 * its arguments. A real approver might prompt a human (Slack button, CLI, queue);
 * here a policy auto-decides.
 *
 * Run with:  bun run examples/tool-approval.ts
 */
import { Agent, type ToolApprover, defineTool } from '../src/index'
import { scriptModel } from './_support/mock-model'

const transfer = defineTool<{ amount: number }>({
  name: 'transfer',
  description: 'transfer money to the user',
  requiresApproval: true, // gated — never runs without the approver's say-so
  parameters: {
    type: 'object',
    properties: { amount: { type: 'number' } },
    required: ['amount'],
  },
  execute: ({ amount }) => `transferred ฿${amount}`,
})

// Policy approver: cap transfers at ฿1,000 (edit), deny anything non-positive.
const policy: ToolApprover = {
  name: 'spend-policy',
  approve: ({ args }) => {
    const amount = Number(args.amount)
    if (amount <= 0) return { decision: 'deny', reason: 'amount must be positive' }
    if (amount > 1000) return { decision: 'edit', args: { amount: 1000 } } // cap it
    return { decision: 'allow' }
  },
}

// The model asks to transfer ฿5,000; the policy caps it to ฿1,000.
const model = scriptModel([
  { content: '', toolCalls: [{ id: 't', name: 'transfer', arguments: { amount: 5000 } }] },
  { content: 'All done — the transfer is on its way.' },
])

const agent = new Agent({
  model,
  tools: [transfer],
  toolApprover: policy,
  hooks: {
    onEvent: (e) => {
      if (e.type === 'tool_approval')
        console.log(`🔒 ${e.tool}: ${e.decision}${e.reason ? ` (${e.reason})` : ''}`)
      if (e.type === 'tool_result') console.log(`   → ${JSON.stringify(e.result)}`)
    },
  },
})

const result = await agent.run('send me ฿5000')
console.log('final:', result.output)
