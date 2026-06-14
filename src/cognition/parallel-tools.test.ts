import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, defineTool } from '../index'
import { ScriptedModel } from '../test-support/scripted-model'

describe('ReActStrategy — parallel tool execution within a step', () => {
  it("runs a step's tool calls concurrently (no deadlock) and records them in call order", async () => {
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const order: string[] = []

    // `slow` blocks until `fast` runs — only possible if they execute concurrently.
    const slow = defineTool({
      name: 'slow',
      description: 'blocks until released',
      execute: async () => {
        order.push('slow:start')
        await slowGate
        order.push('slow:end')
        return 'A'
      },
    })
    const fast = defineTool({
      name: 'fast',
      description: 'releases slow',
      execute: () => {
        order.push('fast')
        releaseSlow()
        return 'B'
      },
    })

    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: 'a', name: 'slow', arguments: {} },
          { id: 'b', name: 'fast', arguments: {} },
        ],
      },
      { content: 'done' },
    ])

    const result = await new Agent({ model, tools: [slow, fast] }).run('go')

    expect(result.output).toBe('done')
    // Concurrency proof: slow started, fast ran and unblocked it, slow finished.
    expect(order).toEqual(['slow:start', 'fast', 'slow:end'])
    // Transcript still records results in the original call order.
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.name)).toEqual([
      'slow',
      'fast',
    ])
    expect(result.toolsInvoked).toEqual(['slow', 'fast'])
  })

  it('joins messages of multiple directReturn tools in call order', async () => {
    const d1 = defineTool({
      name: 'd1',
      description: 'direct 1',
      directReturn: true,
      execute: () => ({ message: 'first' }),
    })
    const d2 = defineTool({
      name: 'd2',
      description: 'direct 2',
      directReturn: true,
      execute: () => ({ message: 'second' }),
    })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: '1', name: 'd1', arguments: {} },
          { id: '2', name: 'd2', arguments: {} },
        ],
      },
    ])

    const result = await new Agent({ model, tools: [d1, d2] }).run('go')
    expect(result.output).toBe('first\n\nsecond')
    expect(result.steps).toBe(1)
    // Raw values preserved in call order for structured consumers.
    expect(result.returns).toEqual([{ message: 'first' }, { message: 'second' }])
  })

  it('preserves structured (object) directReturn values in result.returns', async () => {
    // A tool that returns an object with no `message` field — e.g. a card payload.
    const card = defineTool({
      name: 'render_card',
      description: 'returns a structured card',
      directReturn: true,
      execute: () => ({ type: 'balance_card', balance: 1234, currency: 'THB' }),
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c', name: 'render_card', arguments: {} }] },
    ])

    const result = await new Agent({ model, tools: [card] }).run('show balance')
    // The object is available verbatim...
    expect(result.returns[0]).toEqual({ type: 'balance_card', balance: 1234, currency: 'THB' })
    // ...while `output` is a text fallback (JSON) for display.
    expect(result.output).toContain('balance_card')
  })

  it('returns the directReturn answer when mixed with a normal tool, but still runs both', async () => {
    let normalRan = false
    const normal = defineTool({
      name: 'normal',
      description: 'side effect',
      execute: () => {
        normalRan = true
        return 'side-result'
      },
    })
    const direct = defineTool({
      name: 'direct',
      description: 'final',
      directReturn: true,
      execute: () => ({ message: 'final answer' }),
    })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: 'n', name: 'normal', arguments: {} },
          { id: 'd', name: 'direct', arguments: {} },
        ],
      },
      { content: 'should-not-be-reached' },
    ])

    const result = await new Agent({ model, tools: [normal, direct] }).run('go')
    expect(result.output).toBe('final answer') // directReturn wins
    expect(result.steps).toBe(1) // short-circuited — no second model call
    expect(normalRan).toBe(true) // the normal tool still executed (in parallel)
  })

  it('reports per-loop token usage and the step each tool ran in', async () => {
    const lookup = defineTool({ name: 'lookup', description: 'lookup', execute: () => 'data' })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        usage: { inputTokens: 20, outputTokens: 5 },
      },
      { content: 'done', usage: { inputTokens: 30, outputTokens: 8 } },
    ])
    const events: AgentEvent[] = []
    await new Agent({
      model,
      tools: [lookup],
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    // Per-loop token usage (one `step` event per model call).
    const steps = events.filter((e) => e.type === 'step')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({
      step: 1,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    })
    expect(steps[1]).toMatchObject({
      step: 2,
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
    })

    // Each tool event carries the loop (step) it ran in, plus tool + return value.
    const call = events.find((e) => e.type === 'tool_call')
    const result = events.find((e) => e.type === 'tool_result')
    expect(call).toMatchObject({ step: 1, tool: 'lookup', args: { q: 'x' } })
    expect(result).toMatchObject({ step: 1, tool: 'lookup', result: 'data' })
  })

  it('aggregates a per-loop trace on the result (tokens, text, tools, returns)', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'lookup',
      execute: () => ({ rows: 3 }),
    })
    const model = new ScriptedModel([
      {
        content: 'checking…',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      { content: 'all done', usage: { inputTokens: 5, outputTokens: 3 } },
    ])

    const result = await new Agent({ model, tools: [lookup] }).run('go')

    expect(result.trace).toHaveLength(2)
    expect(result.trace[0]).toEqual({
      step: 1,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      text: 'checking…',
      tools: [{ name: 'lookup', args: { q: 'x' }, result: { rows: 3 } }],
    })
    expect(result.trace[1]).toEqual({
      step: 2,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      text: 'all done',
      tools: [],
    })
  })

  it('emits an output event with final:true for the final answer (default mode)', async () => {
    const outputs: AgentEvent[] = []
    const model = new ScriptedModel([{ content: 'the answer' }])
    await new Agent({
      model,
      hooks: { onEvent: (e) => void (e.type === 'output' && outputs.push(e)) },
    }).run('go')

    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ type: 'output', value: 'the answer', final: true })
  })
})

describe('ReActStrategy — streamDirectReturns (emit-and-continue)', () => {
  it('streams each directReturn as final:false and continues until the final answer', async () => {
    // Two directReturn tools (e.g. cards), each emitted as it runs; then a final answer.
    const bookRoom = defineTool({
      name: 'book_room',
      description: 'book a meeting room',
      directReturn: true,
      execute: () => ({ card: 'room', ref: 'RM-1' }),
    })
    const reimburse = defineTool({
      name: 'reimburse',
      description: 'file a reimbursement',
      directReturn: true,
      execute: () => ({ card: 'expense', ref: 'EX-9' }),
    })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: 'a', name: 'book_room', arguments: {} },
          { id: 'b', name: 'reimburse', arguments: {} },
        ],
      },
      { content: 'Done — booked your room and filed the expense.' },
    ])

    const events: Array<{ value: unknown; final: boolean }> = []
    const result = await new Agent({
      model,
      tools: [bookRoom, reimburse],
      streamDirectReturns: true,
      hooks: {
        onEvent: (e) =>
          void (e.type === 'output' && events.push({ value: e.value, final: e.final })),
      },
    }).run('book a room and file my expense')

    // Two partial results streamed (objects preserved), then one final answer.
    expect(events).toEqual([
      { value: { card: 'room', ref: 'RM-1' }, final: false },
      { value: { card: 'expense', ref: 'EX-9' }, final: false },
      { value: 'Done — booked your room and filed the expense.', final: true },
    ])
    // The loop did NOT short-circuit on the first directReturn.
    expect(result.steps).toBe(2)
    expect(result.output).toBe('Done — booked your room and filed the expense.')
    // All directReturn values are also aggregated on the result.
    expect(result.returns).toEqual([
      { card: 'room', ref: 'RM-1' },
      { card: 'expense', ref: 'EX-9' },
    ])
  })
})
