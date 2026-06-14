/**
 * Department agents + the coordinator, wired with mock models so the example is
 * deterministic and runs offline. Replace the mock models with a real
 * `LanguageModel` (see examples/ai-assistant/gemini-model.ts) and the wiki tool
 * with a real KB/MCP tool to make it production-grade — the structure stays the
 * same.
 */
import { Agent, type AgentHooks, type LanguageModel, type Message } from '../../src/index'
import { type FormEntry, createWikiTool } from './wiki'

/** Most recent tool-result text in the working transcript, if any. */
function lastToolText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'tool') return messages[i]?.content
  }
  return undefined
}

/** Latest user message. */
function lastUserText(messages: Message[]): string {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
}

/**
 * A department agent's mock brain: first call the `wiki_lookup` tool, then reply
 * to the user with the form link from the tool result.
 */
function departmentModel(dept: FormEntry['dept']): LanguageModel {
  return {
    id: `mock:${dept}`,
    generate: ({ messages }) => {
      const toolText = lastToolText(messages)
      if (!toolText) {
        return Promise.resolve({
          content: '',
          toolCalls: [
            { id: 'w1', name: 'wiki_lookup', arguments: { query: lastUserText(messages) } },
          ],
        })
      }
      let title = ''
      let url = ''
      try {
        const r = JSON.parse(toolText) as { title?: string; url?: string }
        title = r.title ?? ''
        url = r.url ?? ''
      } catch {}
      return Promise.resolve({
        content: url ? `นี่ครับ — ${title}\n${url}` : 'ขออภัย ไม่พบฟอร์มที่เกี่ยวข้องครับ',
      })
    },
  }
}

export interface Department {
  agent: Agent
  toolName: string
  description: string
}

/** Build the four department agents (each with its own wiki tool). */
export function buildDepartments(hooks?: AgentHooks): Department[] {
  const make = (
    dept: FormEntry['dept'],
    persona: string,
    toolName: string,
    description: string,
  ): Department => ({
    agent: new Agent({
      name: `${dept}-agent`,
      model: departmentModel(dept),
      instructions: persona,
      tools: [createWikiTool(dept)],
      hooks,
      maxSteps: 3,
    }),
    toolName,
    description,
  })

  return [
    make(
      'hr',
      'You are the HR assistant.',
      'hr_agent',
      'Recruitment, headcount, leave, and employee HR forms',
    ),
    make(
      'account',
      'You are the Accounting assistant.',
      'account_agent',
      'Expense, reimbursement, and finance forms',
    ),
    make(
      'it',
      'You are the IT support assistant.',
      'it_agent',
      'IT support, hardware/software, and access requests',
    ),
    make(
      'admin',
      'You are the Office Admin assistant.',
      'admin_agent',
      'Office facilities, meeting room and asset booking',
    ),
  ]
}

/** Keyword router used by the coordinator to classify which department fits. */
const ROUTING: Array<{ tool: string; keywords: string[] }> = [
  {
    tool: 'hr_agent',
    keywords: ['พนักงาน', 'รับสมัคร', 'สมัครงาน', 'ลา', 'อัตรากำลัง', 'เพิ่มคน', 'headcount', 'hr'],
  },
  {
    tool: 'account_agent',
    keywords: ['เบิก', 'ค่าใช้จ่าย', 'ค่าเดินทาง', 'การเงิน', 'บัญชี', 'reimburse', 'expense'],
  },
  {
    tool: 'it_agent',
    keywords: ['คอมพิวเตอร์', 'ซ่อม', 'wifi', 'อินเทอร์เน็ต', 'รหัสผ่าน', 'ระบบ', 'it', 'support'],
  },
  {
    tool: 'admin_agent',
    keywords: ['จอง', 'ห้องประชุม', 'รถ', 'อุปกรณ์', 'สำนักงาน', 'ออฟฟิศ', 'booking'],
  },
]

/**
 * The coordinator's mock brain: classify the request → delegate to a department
 * agent (a tool) → surface the department's answer. This is the classify-and-route
 * step; a real coordinator would use an LLM (or a `Planner`) to choose.
 */
export function coordinatorModel(): LanguageModel {
  return {
    id: 'mock:coordinator',
    generate: ({ messages }) => {
      const toolText = lastToolText(messages)
      if (toolText) {
        let message = toolText
        try {
          const r = JSON.parse(toolText) as { message?: string }
          if (r.message) message = r.message
        } catch {}
        return Promise.resolve({ content: message })
      }
      const q = lastUserText(messages).toLowerCase()
      const route = ROUTING.find((r) => r.keywords.some((k) => q.includes(k.toLowerCase())))
      if (!route) {
        return Promise.resolve({
          content: 'ขออภัย ไม่แน่ใจว่าเรื่องนี้ของแผนกไหน รบกวนระบุรายละเอียดเพิ่มเติมครับ',
        })
      }
      return Promise.resolve({
        content: '',
        toolCalls: [
          { id: 'route', name: route.tool, arguments: { input: lastUserText(messages) } },
        ],
      })
    },
  }
}
