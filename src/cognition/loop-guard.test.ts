import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel, defineTool } from '../index'
import { ScriptedModel } from '../test-support/scripted-model'

describe('ReActStrategy — repeated-call guard', () => {
  it('executes a relentlessly-repeated identical call only once (no oscillation)', async () => {
    let exec = 0
    const tool = defineTool({
      name: 'A',
      description: 'tool A',
      execute: (args) => {
        exec++
        return `ran ${JSON.stringify(args)}`
      },
    })
    // A stubborn model that asks for the exact same call on every single loop.
    const stubborn: LanguageModel = {
      id: 'stubborn',
      generate: () =>
        Promise.resolve({ content: '', toolCalls: [{ id: 'x', name: 'A', arguments: { n: 5 } }] }),
    }

    const results: unknown[] = []
    await new Agent({
      model: stubborn,
      tools: [tool],
      maxSteps: 5,
      hooks: { onEvent: (e) => void (e.type === 'tool_result' && results.push(e.result)) },
    }).run('go')

    // Executed once; every later step is blocked (was 3× before the fix).
    expect(exec).toBe(1)
    expect(results[0]).toBe('ran {"n":5}')
    for (const r of results.slice(1)) {
      expect((r as { error: string }).error).toContain('repeat blocked')
    }
  })

  it('allows a re-call once another tool breaks the streak', async () => {
    let execA = 0
    let execB = 0
    const a = defineTool({
      name: 'A',
      description: 'a',
      execute: () => {
        execA++
        return 'a'
      },
    })
    const b = defineTool({
      name: 'B',
      description: 'b',
      execute: () => {
        execB++
        return 'b'
      },
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: '1', name: 'A', arguments: { n: 5 } }] },
      { content: '', toolCalls: [{ id: '2', name: 'B', arguments: {} }] },
      { content: '', toolCalls: [{ id: '3', name: 'A', arguments: { n: 5 } }] }, // allowed again
      { content: 'done' },
    ])

    await new Agent({ model, tools: [a, b], maxSteps: 6 }).run('go')
    expect(execA).toBe(2)
    expect(execB).toBe(1)
  })

  it('allows consecutive calls when the arguments differ', async () => {
    const seen: unknown[] = []
    const a = defineTool({
      name: 'A',
      description: 'a',
      execute: (args) => {
        seen.push(args)
        return 'ok'
      },
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: '1', name: 'A', arguments: { n: 5 } }] },
      { content: '', toolCalls: [{ id: '2', name: 'A', arguments: { n: 6 } }] },
      { content: 'done' },
    ])

    await new Agent({ model, tools: [a], maxSteps: 5 }).run('go')
    expect(seen).toEqual([{ n: 5 }, { n: 6 }])
  })
})
