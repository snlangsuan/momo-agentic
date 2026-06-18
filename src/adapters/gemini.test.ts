import { describe, expect, it, mock } from 'bun:test'

// --- Fake @google/genai SDK (no network) -----------------------------------
let lastClientOptions: Record<string, unknown> | undefined
const requests: Array<Record<string, unknown>> = []

class FakeModels {
  generateContent(req: Record<string, unknown>) {
    requests.push(req)
    return Promise.resolve({
      text: 'hello',
      functionCalls: [{ name: 'lookup', args: { city: 'BKK' } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
    })
  }
  async *streamGen() {
    yield { text: 'he' }
    yield {
      text: 'llo',
      functionCalls: [{ name: 'lookup', args: { city: 'BKK' } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
    }
  }
  generateContentStream(req: Record<string, unknown>) {
    requests.push(req)
    return Promise.resolve(this.streamGen())
  }
}

class FakeGoogleGenAI {
  models = new FakeModels()
  constructor(options: Record<string, unknown>) {
    lastClientOptions = options
  }
}

mock.module('@google/genai', () => ({ GoogleGenAI: FakeGoogleGenAI }))

const { createGeminiModel } = await import('./gemini')

describe('createGeminiModel — backend selection', () => {
  it('uses the Gemini Developer API (apiKey) by default', () => {
    createGeminiModel({ apiKey: 'k-123' })
    expect(lastClientOptions).toEqual({ apiKey: 'k-123' })
  })

  it('uses Vertex AI when vertexai: true', () => {
    createGeminiModel({ vertexai: true, project: 'p1', location: 'us-central1' })
    expect(lastClientOptions).toEqual({ vertexai: true, project: 'p1', location: 'us-central1' })
  })

  it('defaults the model id and honors an override', () => {
    expect(createGeminiModel({ apiKey: 'k' }).id).toBe('gemini-3.0-pro')
    expect(createGeminiModel({ apiKey: 'k', model: 'gemini-3.0-flash' }).id).toBe(
      'gemini-3.0-flash',
    )
  })
})

describe('createGeminiModel — generate', () => {
  it('maps the transcript and parses content, tool calls, and usage', async () => {
    requests.length = 0
    const model = createGeminiModel({ apiKey: 'k' })
    const res = await model.generate({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    })

    const req = requests[0] as { config: { systemInstruction?: string; tools?: unknown[] } }
    expect(req.config.systemInstruction).toBe('be brief')
    expect(req.config.tools).toBeDefined()

    expect(res.content).toBe('hello')
    expect(res.toolCalls).toEqual([{ id: 'lookup-0', name: 'lookup', arguments: { city: 'BKK' } }])
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 })
  })

  it('maps a tool result into a functionResponse content', async () => {
    requests.length = 0
    const model = createGeminiModel({ apiKey: 'k' })
    await model.generate({
      messages: [{ role: 'tool', name: 'lookup', content: '{"temp":31}', toolCallId: 'x' }],
      tools: [],
    })
    const req = requests[0] as { contents: Array<{ role: string; parts: unknown[] }> }
    expect(req.contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'lookup', response: { temp: 31 } },
    })
  })
})

describe('createGeminiModel — generateStream', () => {
  it('yields text deltas and returns the final response with tool calls + usage', async () => {
    const model = createGeminiModel({ apiKey: 'k' })
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
    expect(next.value.toolCalls).toEqual([
      { id: 'lookup-0', name: 'lookup', arguments: { city: 'BKK' } },
    ])
    expect(next.value.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
  })
})

describe('createGeminiModel — message mapping', () => {
  type Content = { role: string; parts: Array<Record<string, unknown>> }

  it('maps multimodal user parts (text, image URL, inline file)', async () => {
    requests.length = 0
    await createGeminiModel({ apiKey: 'k' }).generate({
      messages: [
        {
          role: 'user',
          content: 'look',
          parts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { url: 'https://x/c.png', mimeType: 'image/png' } },
            { type: 'file', source: { data: 'B64', mimeType: 'application/pdf' }, name: 'd.pdf' },
          ],
        },
      ],
      tools: [],
    })
    const parts = (requests[0] as { contents: Content[] }).contents[0]?.parts
    expect(parts?.[0]).toEqual({ text: 'what is this?' })
    expect(parts?.[1]).toEqual({ fileData: { fileUri: 'https://x/c.png', mimeType: 'image/png' } })
    expect(parts?.[2]).toEqual({ inlineData: { data: 'B64', mimeType: 'application/pdf' } })
  })

  it('maps an assistant turn with tool calls to functionCall parts', async () => {
    requests.length = 0
    await createGeminiModel({ apiKey: 'k' }).generate({
      messages: [
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: '1', name: 'lookup', arguments: { city: 'BKK' } }],
        },
        { role: 'system', content: 'be brief' },
      ],
      tools: [],
    })
    const contents = requests[0] as { contents: Content[]; config: { systemInstruction?: string } }
    expect(contents.contents[0]?.role).toBe('model')
    expect(contents.contents[0]?.parts).toContainEqual({
      functionCall: { name: 'lookup', args: { city: 'BKK' } },
    })
    // system message is collected into systemInstruction, not contents
    expect(contents.config.systemInstruction).toBe('be brief')
  })
})
