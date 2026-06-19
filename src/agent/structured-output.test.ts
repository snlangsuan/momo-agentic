import { describe, expect, it } from 'bun:test'
import { Agent, AgentError } from '@/index'
import { ScriptedModel } from '@/test-support/scripted-model'

const schema = {
  type: 'object',
  properties: { city: { type: 'string' }, celsius: { type: 'number' } },
  required: ['city', 'celsius'],
}

/** A model that answers by calling the synthetic `respond` tool. */
const respondWith = (args: Record<string, unknown>, name = 'respond') =>
  new ScriptedModel([{ content: '', toolCalls: [{ id: 'r', name, arguments: args }] }])

describe('Structured / typed output', () => {
  it('captures the structured object on RunResult.object and JSON on output', async () => {
    const model = respondWith({ city: 'Bangkok', celsius: 34 })
    const result = await new Agent({ model, responseSchema: { schema } }).run('weather?')

    expect(result.object).toEqual({ city: 'Bangkok', celsius: 34 })
    expect(JSON.parse(result.output)).toEqual({ city: 'Bangkok', celsius: 34 })
  })

  it('exposes the respond tool to the model with the schema as its parameters', async () => {
    const model = respondWith({ city: 'X', celsius: 1 })
    await new Agent({ model, responseSchema: { schema } }).run('go')
    const offered = model.calls[0]?.tools.find((t) => t.name === 'respond')
    expect(offered?.parameters).toEqual(schema)
  })

  it('honors a custom tool name', async () => {
    const model = respondWith({ city: 'Y', celsius: 2 }, 'final_answer')
    const result = await new Agent({
      model,
      responseSchema: { name: 'final_answer', schema },
    }).run('go')
    expect(result.object).toEqual({ city: 'Y', celsius: 2 })
  })

  it('runs the optional parse() to validate/coerce, and stores its return', async () => {
    const model = respondWith({ city: 'Bangkok', celsius: 34 })
    const result = await new Agent({
      model,
      responseSchema: {
        schema,
        parse: (data) => ({ ...(data as object), label: 'parsed' }),
      },
    }).run('go')
    expect(result.object).toMatchObject({ city: 'Bangkok', label: 'parsed' })
  })

  it('raises AgentError(response_schema) when required fields are missing', async () => {
    const model = respondWith({ city: 'Bangkok' }) // missing celsius
    await expect(new Agent({ model, responseSchema: { schema } }).run('go')).rejects.toMatchObject({
      name: 'AgentError',
      stage: 'response_schema',
    })
  })

  it('falls back to parsing the output as JSON when the model answers in text', async () => {
    // No tool call — the model just emits JSON text.
    const model = new ScriptedModel([{ content: '{"city":"Phuket","celsius":31}' }])
    const result = await new Agent({ model, responseSchema: { schema } }).run('go')
    expect(result.object).toEqual({ city: 'Phuket', celsius: 31 })
  })

  it('leaves object undefined when no responseSchema is configured', async () => {
    const model = new ScriptedModel([{ content: 'plain' }])
    const result = await new Agent({ model }).run('go')
    expect(result.object).toBeUndefined()
  })

  it('repairs an invalid structured answer when `repair` is set', async () => {
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'r1', name: 'respond', arguments: { city: 'Bangkok' } }] }, // missing celsius
      {
        content: '',
        toolCalls: [{ id: 'r2', name: 'respond', arguments: { city: 'Bangkok', celsius: 34 } }],
      }, // corrected
    ])
    const result = await new Agent({ model, responseSchema: { schema, repair: 1 } }).run('go')

    expect(result.object).toEqual({ city: 'Bangkok', celsius: 34 })
    expect(model.calls).toHaveLength(2) // initial + one repair re-run
    // A corrective message was injected into the transcript before the re-run.
    expect(
      result.messages.some((m) => m.role === 'user' && m.content.includes('did not match')),
    ).toBe(true)
  })

  it('still raises AgentError(response_schema) when repair attempts are exhausted', async () => {
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'r1', name: 'respond', arguments: { city: 'A' } }] },
      { content: '', toolCalls: [{ id: 'r2', name: 'respond', arguments: { city: 'B' } }] }, // still invalid
    ])
    await expect(
      new Agent({ model, responseSchema: { schema, repair: 1 } }).run('go'),
    ).rejects.toMatchObject({ name: 'AgentError', stage: 'response_schema' })
    expect(model.calls).toHaveLength(2)
  })

  it('accumulates usage and trace across repair attempts', async () => {
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [{ id: 'r1', name: 'respond', arguments: { city: 'A' } }],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      {
        content: '',
        toolCalls: [{ id: 'r2', name: 'respond', arguments: { city: 'A', celsius: 1 } }],
        usage: { inputTokens: 8, outputTokens: 3 },
      },
    ])
    const result = await new Agent({ model, responseSchema: { schema, repair: 2 } }).run('go')

    expect(result.object).toEqual({ city: 'A', celsius: 1 })
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 5, totalTokens: 23 })
    expect(result.trace).toHaveLength(2)
  })

  it('surfaces a parse() rejection as AgentError(response_schema)', async () => {
    const model = respondWith({ city: 'Bangkok', celsius: 34 })
    const agent = new Agent({
      model,
      responseSchema: {
        schema,
        parse: () => {
          throw new Error('zod: invalid')
        },
      },
    })
    await expect(agent.run('go')).rejects.toBeInstanceOf(AgentError)
  })
})
