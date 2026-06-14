/**
 * Company multi-agent example (Layer 2 — Agent Internet).
 *
 * A reception/coordinator agent classifies each employee request and delegates
 * to the right department agent (HR / Account / IT / Admin). The department
 * agent then picks the right tool (a company-wiki lookup) and returns the form
 * link — e.g. "อยากได้ฟอร์มขอรับพนักงานเพิ่ม" → HR → headcount-request form.
 *
 *   reception ──classify──▶ hr-agent ──wiki_lookup──▶ HR headcount form link
 *                          account-agent              Expense form link
 *                          it-agent                   IT support form link
 *                          admin-agent                Room booking form link
 *
 * Run with:  bun run examples/company-agents/index.ts
 */
import { Agent, type AgentEvent, agentAsTool } from '../../src/index'
import { buildDepartments, coordinatorModel } from './agents'

// Trace the chain: coordinator routing → department tool use.
const hooks = {
  onEvent: (e: AgentEvent) => {
    if (e.type === 'tool_call') {
      const what =
        e.tool === 'wiki_lookup' ? `wiki_lookup(${JSON.stringify(e.args)})` : `delegate → ${e.tool}`
      console.log(`   ↳ [${e.agent}] ${what}`)
    }
  },
}

const departments = buildDepartments(hooks)

// The departments become tools the coordinator can call (= classify + handoff).
const reception = new Agent({
  name: 'reception',
  model: coordinatorModel(),
  instructions: 'You are the company reception bot. Route each request to the correct department.',
  tools: departments.map((d) =>
    agentAsTool(d.agent, { name: d.toolName, description: d.description }),
  ),
  hooks,
  maxSteps: 4,
})

const requests = [
  'อยากได้ฟอร์มขอรับพนักงานเพิ่ม',
  'ขอเบิกค่าเดินทางไปประชุมต่างจังหวัด',
  'คอมพิวเตอร์เสีย ขอแจ้งซ่อมหน่อย',
  'ขอจองห้องประชุมพรุ่งนี้บ่ายสอง',
]

for (const q of requests) {
  console.log(`\n❓ ${q}`)
  const result = await reception.run(q)
  console.log(`🤖 ${result.output}`)
}
