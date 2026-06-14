/**
 * A mock "company wiki" knowledge base + a `wiki_lookup` tool that returns the
 * matching form link. In a real app this tool would query your docs/RAG/MCP
 * server (see examples/ai-assistant/mcp.ts); here it's an in-memory table so the
 * example runs offline.
 */
import { type Tool, defineTool } from '../../src/index'

export interface FormEntry {
  dept: 'hr' | 'account' | 'it' | 'admin'
  title: string
  url: string
  keywords: string[]
}

export const FORM_KB: FormEntry[] = [
  {
    dept: 'hr',
    title: 'ฟอร์มขอรับพนักงานเพิ่ม (Headcount Request)',
    url: 'https://wiki.acme.co/forms/hr/headcount-request',
    keywords: ['พนักงาน', 'รับพนักงาน', 'เพิ่มคน', 'อัตรากำลัง', 'headcount', 'recruit'],
  },
  {
    dept: 'hr',
    title: 'ฟอร์มขอลา (Leave Request)',
    url: 'https://wiki.acme.co/forms/hr/leave',
    keywords: ['ลา', 'ลาพักร้อน', 'ลากิจ', 'leave'],
  },
  {
    dept: 'account',
    title: 'ฟอร์มเบิกค่าใช้จ่าย (Expense Reimbursement)',
    url: 'https://wiki.acme.co/forms/account/reimbursement',
    keywords: ['เบิก', 'ค่าใช้จ่าย', 'ค่าเดินทาง', 'reimburse', 'expense'],
  },
  {
    dept: 'it',
    title: 'ฟอร์มแจ้งซ่อม/ขอความช่วยเหลือ IT (IT Support Ticket)',
    url: 'https://wiki.acme.co/forms/it/support',
    keywords: ['คอมพิวเตอร์', 'ซ่อม', 'โน้ตบุ๊ก', 'wifi', 'อินเทอร์เน็ต', 'รหัสผ่าน', 'it', 'support'],
  },
  {
    dept: 'admin',
    title: 'ฟอร์มจองห้องประชุม (Meeting Room Booking)',
    url: 'https://wiki.acme.co/forms/admin/room-booking',
    keywords: ['จอง', 'ห้องประชุม', 'รถ', 'อุปกรณ์', 'สำนักงาน', 'booking'],
  },
]

/** A wiki-lookup tool scoped to one department's forms. */
export function createWikiTool(dept: FormEntry['dept']): Tool {
  return defineTool<{ query: string }>({
    name: 'wiki_lookup',
    description: 'Search the company wiki and return the form (title + url) matching the request.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the user is asking for' } },
      required: ['query'],
    },
    execute: ({ query }) => {
      const q = query.toLowerCase()
      const scoped = FORM_KB.filter((f) => f.dept === dept)
      const hit =
        scoped.find((f) => f.keywords.some((k) => q.includes(k.toLowerCase()))) ?? scoped[0]
      return hit ? { title: hit.title, url: hit.url } : { error: 'No matching form found.' }
    },
  })
}
