import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel, defineTool } from '../index'

const callOnce = (tool: string, args: Record<string, unknown>): LanguageModel['generate'] => {
  let step = 0
  return () => {
    step++
    return Promise.resolve(
      step === 1
        ? { content: '', toolCalls: [{ id: '1', name: tool, arguments: args }] }
        : { content: 'done' },
    )
  }
}

describe('ReActStrategy — argument validation', () => {
  it('rejects a call with a missing required arg before execute, model gets the error', async () => {
    let ran = false
    const tool = defineTool<{ city: string }>({
      name: 'weather',
      description: 'w',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute: () => {
        ran = true
        return 'sunny'
      },
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('weather', { country: 'TH' }) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')

    expect(ran).toBe(false)
    expect((results[0] as { error: string }).error).toContain('missing required property "city"')
  })

  it('rejects a wrong-typed arg', async () => {
    const tool = defineTool({
      name: 'weather',
      description: 'w',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute: () => 'sunny',
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('weather', { city: 42 }) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')
    expect((results[0] as { error: string }).error).toContain('property "city" must be string')
  })

  it('runs a custom parse and feeds its thrown message back to the model', async () => {
    let received: unknown
    const tool = defineTool<{ n: number }>({
      name: 'calc',
      description: 'c',
      parse: (args) => {
        if (typeof args.n !== 'number' || args.n < 0) throw new Error('n must be a positive number')
        return { n: args.n }
      },
      execute: (args) => {
        received = args
        return 'ok'
      },
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('calc', { n: -1 }) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')

    expect(received).toBeUndefined()
    expect((results[0] as { error: string }).error).toContain('n must be a positive number')
  })

  it('passes coerced arguments from parse through to execute', async () => {
    let received: unknown
    const tool = defineTool<{ n: number }>({
      name: 'calc',
      description: 'c',
      parse: (args) => ({ n: Number(args.n) }),
      execute: (args) => {
        received = args
        return 'ok'
      },
    })
    await new Agent({
      model: { id: 'm', generate: callOnce('calc', { n: '7' }) },
      tools: [tool],
      maxSteps: 3,
    }).run('go')
    expect(received).toEqual({ n: 7 })
  })
})

describe('ReActStrategy — per-tool timeout', () => {
  it('aborts a tool that exceeds its timeoutMs and reports it to the model', async () => {
    const tool = defineTool({
      name: 'slow',
      description: 's',
      timeoutMs: 20,
      execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('slow', {}) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')

    expect((results[0] as { error: string }).error).toContain('timed out after 20ms')
  })

  it('lets a fast tool finish normally', async () => {
    const tool = defineTool({
      name: 'fast',
      description: 'f',
      timeoutMs: 200,
      execute: () => new Promise((resolve) => setTimeout(() => resolve('quick'), 5)),
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('fast', {}) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')
    expect(results[0]).toBe('quick')
  })

  it('chains the run signal into the tool (cooperative cancel)', async () => {
    const tool = defineTool({
      name: 'observe',
      description: 'o',
      timeoutMs: 30,
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve('aborted'))
        }),
    })
    const results: unknown[] = []
    await new Agent({
      model: { id: 'm', generate: callOnce('observe', {}) },
      tools: [tool],
      maxSteps: 3,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')
    // The tool resolves via the chained abort before the timeout rejection surfaces.
    expect(results[0]).toBe('aborted')
  })
})
