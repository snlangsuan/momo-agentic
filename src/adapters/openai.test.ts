import { describe, expect, it, mock } from 'bun:test'

// --- Fake openai SDK (no network) ------------------------------------------
let lastClientOptions: Record<string, unknown> | undefined
const bodies: Array<Record<string, unknown>> = []

class FakeCompletions {
  // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the SDK's loose overloads
  create(body: any): Promise<any> {
    bodies.push(body)
    if (body.stream) {
      return Promise.resolve(
        (async function* () {
          yield { choices: [{ delta: { content: 'he' } }] }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 't1', function: { name: 'lookup', arguments: '{"a":' } },
                  ],
                },
              },
            ],
          }
          yield {
            choices: [
              {
                delta: {
                  content: 'llo',
                  tool_calls: [{ index: 0, function: { arguments: '1}' } }],
                },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }
        })(),
      )
    }
    return Promise.resolve({
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    })
  }
}

class FakeOpenAI {
  chat = { completions: new FakeCompletions() }
  constructor(options: Record<string, unknown>) {
    lastClientOptions = options
  }
}

mock.module('openai', () => ({ default: FakeOpenAI }))

const { createOpenAIModel } = await import('@/adapters/openai')

describe('createOpenAIModel — construction', () => {
  it('exposes the model id and both generate methods', () => {
    const model = createOpenAIModel({ model: 'gpt-4o-mini', apiKey: 'k' })
    expect(model.id).toBe('gpt-4o-mini')
    expect(typeof model.generate).toBe('function')
    expect(typeof model.generateStream).toBe('function')
  })

  it('forwards baseURL + headers for OpenAI-compatible hosts', () => {
    createOpenAIModel({
      model: 'llama3.1',
      baseURL: 'http://localhost:11434/v1',
      headers: { 'x-title': 'momo' },
    })
    expect(lastClientOptions?.baseURL).toBe('http://localhost:11434/v1')
    expect(lastClientOptions?.defaultHeaders).toEqual({ 'x-title': 'momo' })
  })
})

describe('createOpenAIModel — generate', () => {
  it('maps messages/tools and parses content, tool calls, and usage', async () => {
    bodies.length = 0
    const model = createOpenAIModel({ model: 'gpt-4o-mini', apiKey: 'k', temperature: 0.2 })
    const res = await model.generate({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    })

    const body = bodies[0] as {
      stream: boolean
      temperature: number
      tools: unknown[]
      messages: Array<{ role: string }>
    }
    expect(body.stream).toBe(false)
    expect(body.temperature).toBe(0.2)
    expect(body.tools).toHaveLength(1)
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])

    expect(res.content).toBe('hello')
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: { a: 1 } }])
    expect(res.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  })

  it('serializes assistant tool calls and tool results', async () => {
    bodies.length = 0
    const model = createOpenAIModel({ model: 'm', apiKey: 'k' })
    await model.generate({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: { city: 'BKK' } }],
        },
        { role: 'tool', name: 'lookup', content: '31C', toolCallId: 'c1' },
      ],
      tools: [],
    })
    const body = bodies[0] as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"city":"BKK"}' } },
      ],
    })
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '31C' })
  })
})

describe('createOpenAIModel — generateStream', () => {
  it('yields deltas and assembles streamed tool-call fragments', async () => {
    const model = createOpenAIModel({ model: 'm', apiKey: 'k' })
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
    // arguments arrived in two fragments: '{"a":' + '1}'
    expect(next.value.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: { a: 1 } }])
    expect(next.value.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
  })
})

describe('createOpenAIModel — multimodal mapping', () => {
  it('maps text + image (URL and inline base64) + other media to content parts', async () => {
    bodies.length = 0
    await createOpenAIModel({ model: 'm', apiKey: 'k' }).generate({
      messages: [
        {
          role: 'user',
          content: 'look',
          parts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { url: 'https://x/c.png' } },
            { type: 'image', source: { data: 'B64', mimeType: 'image/png' } },
            { type: 'file', source: { url: 'https://x/d.pdf' }, name: 'd.pdf' },
          ],
        },
      ],
      tools: [],
    })
    const content = (bodies[0] as { messages: Array<{ content: unknown }> }).messages[0]?.content
    expect(content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'https://x/c.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B64' } },
      { type: 'text', text: '[file]' }, // non-image media kept as a marker
    ])
  })
})
