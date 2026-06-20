import { describe, expect, it, mock } from 'bun:test'

// --- Fake @anthropic-ai/sdk (no network) -----------------------------------
let lastClientOptions: Record<string, unknown> | undefined
const bodies: Array<Record<string, unknown>> = []

const RESPONSE = {
  content: [
    { type: 'text', text: 'hello' },
    { type: 'tool_use', id: 't1', name: 'lookup', input: { city: 'BKK' } },
  ],
  usage: { input_tokens: 4, output_tokens: 6 },
}

class FakeMessages {
  // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the SDK's loose overloads
  create(body: any): Promise<any> {
    bodies.push(body)
    return Promise.resolve(RESPONSE)
  }

  // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the SDK's stream helper
  stream(body: any): any {
    bodies.push(body)
    const iter = (async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } }
      yield { type: 'content_block_start', content_block: { type: 'text' } } // ignored
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } }
    })()
    return {
      [Symbol.asyncIterator]: () => iter,
      finalMessage: () => Promise.resolve(RESPONSE),
    }
  }
}

class FakeAnthropic {
  messages = new FakeMessages()
  constructor(options: Record<string, unknown>) {
    lastClientOptions = options
  }
}

mock.module('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

const { createAnthropicModel } = await import('@/adapters/anthropic')

describe('createAnthropicModel — client + defaults', () => {
  it('passes apiKey/baseURL/headers and defaults the model id', () => {
    const model = createAnthropicModel({
      apiKey: 'k-123',
      baseURL: 'https://gw',
      headers: { 'x-beta': '1' },
    })
    expect(model.id).toBe('claude-opus-4-8')
    expect(lastClientOptions).toEqual({
      apiKey: 'k-123',
      baseURL: 'https://gw',
      defaultHeaders: { 'x-beta': '1' },
    })
  })

  it('honors a model override', () => {
    expect(createAnthropicModel({ apiKey: 'k', model: 'claude-haiku-4-5' }).id).toBe(
      'claude-haiku-4-5',
    )
  })
})

describe('createAnthropicModel — generate', () => {
  it('maps system + transcript and parses content, tool calls, and usage', async () => {
    bodies.length = 0
    const res = await createAnthropicModel({ apiKey: 'k' }).generate({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    })

    const body = bodies[0] as {
      system?: string
      max_tokens: number
      tools?: Array<{ name: string; description: string; input_schema: unknown }>
      temperature?: number
    }
    expect(body.system).toBe('be brief')
    expect(body.max_tokens).toBe(4096)
    expect(body.tools?.[0]).toEqual({
      name: 'lookup',
      description: 'd',
      input_schema: { type: 'object' },
    })
    // temperature is omitted unless explicitly set (newer models reject it)
    expect(body.temperature).toBeUndefined()

    expect(res.content).toBe('hello')
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: { city: 'BKK' } }])
    expect(res.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  })

  it('sends temperature only when provided, and respects maxTokens', async () => {
    bodies.length = 0
    await createAnthropicModel({ apiKey: 'k', temperature: 0.2, maxTokens: 1000 }).generate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    const body = bodies[0] as { temperature?: number; max_tokens: number; tools?: unknown }
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(1000)
    expect(body.tools).toBeUndefined() // no tools key when none supplied
  })

  it('maps an assistant tool call + a tool result back into Claude blocks', async () => {
    bodies.length = 0
    await createAnthropicModel({ apiKey: 'k' }).generate({
      messages: [
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 't1', name: 'lookup', arguments: { city: 'BKK' } }],
        },
        { role: 'tool', name: 'lookup', content: '{"temp":31}', toolCallId: 't1' },
      ],
      tools: [],
    })
    const body = bodies[0] as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'lookup', input: { city: 'BKK' } },
      ],
    })
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"temp":31}' }],
    })
  })

  it('maps multimodal user parts (text + image URL)', async () => {
    bodies.length = 0
    await createAnthropicModel({ apiKey: 'k' }).generate({
      messages: [
        {
          role: 'user',
          content: 'look',
          parts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { url: 'https://x/c.png', mimeType: 'image/png' } },
          ],
        },
      ],
      tools: [],
    })
    const body = bodies[0] as { messages: Array<{ content: unknown[] }> }
    expect(body.messages[0]?.content[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(body.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://x/c.png' },
    })
  })
})

describe('createAnthropicModel — generateStream', () => {
  it('yields text deltas and returns the final response with tool calls + usage', async () => {
    const model = createAnthropicModel({ apiKey: 'k' })
    const gen = model.generateStream?.({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
    if (!gen) throw new Error('generateStream missing')

    const deltas: string[] = []
    let next = await gen.next()
    while (!next.done) {
      deltas.push(next.value.delta)
      next = await gen.next()
    }
    expect(deltas).toEqual(['he', 'llo'])
    expect(next.value.content).toBe('hello')
    expect(next.value.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: { city: 'BKK' } }])
    expect(next.value.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  })
})
