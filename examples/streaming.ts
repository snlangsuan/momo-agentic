/**
 * Streaming results via callback (Layers 7 + 8) — don't wait for the final
 * return. With `streamDirectReturns`, each `directReturn` tool result is emitted
 * as an `output` event (`final: false`) the moment it runs, the loop keeps going,
 * and the final answer arrives as `output` with `final: true`.
 *
 * Useful for multi-action turns: "book a room and file my expense" → two cards
 * stream out, then a closing message.
 *
 * Run with:  bun run examples/streaming.ts
 */
import { Agent, type LanguageModel, defineTool } from '../src/index'

const bookRoom = defineTool({
  name: 'book_room',
  description: 'Book a meeting room',
  directReturn: true,
  execute: () => ({ card: 'room_booking', ref: 'RM-1042', when: 'tomorrow 14:00' }),
})
const reimburse = defineTool({
  name: 'reimburse',
  description: 'File an expense reimbursement',
  directReturn: true,
  execute: () => ({ card: 'expense', ref: 'EX-2207', amount: 1500 }),
})

// Mock model: ask for both actions, then close with a final message.
let turn = 0
const model: LanguageModel = {
  id: 'mock',
  generate: () => {
    turn++
    if (turn === 1) {
      return Promise.resolve({
        content: '',
        toolCalls: [
          { id: 'a', name: 'book_room', arguments: {} },
          { id: 'b', name: 'reimburse', arguments: {} },
        ],
      })
    }
    return Promise.resolve({ content: 'จัดการให้เรียบร้อยแล้วครับ — จองห้องและยื่นเบิกค่าใช้จ่ายเรียบร้อย' })
  },
}

const agent = new Agent({
  model,
  tools: [bookRoom, reimburse],
  streamDirectReturns: true, // ← emit-and-continue
  hooks: {
    onEvent: (e) => {
      if (e.type === 'output') {
        if (e.final) console.log(`✅ FINAL: ${e.value}`)
        else console.log('📨 partial:', e.value) // structured object, streamed live
      }
    },
  },
})

const result = await agent.run('จองห้องประชุมพรุ่งนี้บ่ายสอง แล้วก็ยื่นเบิกค่าใช้จ่ายให้ด้วย')
console.log('\nAggregated returns:', result.returns)
