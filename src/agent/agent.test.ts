import { describe, expect, it } from 'bun:test'
import type { Planner } from '../cognition/planner'
import { InMemoryMemory } from '../memory/in-memory'
import { type AgentEvent, UsageTracker } from '../observability/hooks'
import { defineToolProvider } from '../protocol/provider'
import { ScriptedModel } from '../test-support/scripted-model'
import { defineTool } from '../tooling/tool'
import { Agent } from './agent'

describe('Agent', () => {
  it('returns the model output directly when no tools are called', async () => {
    const model = new ScriptedModel([
      { content: 'hello world', usage: { inputTokens: 5, outputTokens: 2 } },
    ])
    const agent = new Agent({ model })

    const result = await agent.run('hi')

    expect(result.output).toBe('hello world')
    expect(result.steps).toBe(1)
    expect(result.usage.totalTokens).toBe(7)
  })

  it('executes a tool call and feeds the result back to the model', async () => {
    const getWeather = defineTool<{ city: string }>({
      name: 'get_weather',
      description: 'Get the current weather for a city',
      execute: ({ city }) => `It is sunny in ${city}.`,
    })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Bangkok' } }],
      },
      { content: 'The weather in Bangkok is sunny.' },
    ])
    const agent = new Agent({ model, tools: [getWeather] })

    const result = await agent.run('weather in Bangkok?')

    expect(result.output).toBe('The weather in Bangkok is sunny.')
    expect(result.toolsInvoked).toEqual(['get_weather'])
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe('It is sunny in Bangkok.')
  })

  it('short-circuits on a directReturn tool', async () => {
    const finish = defineTool({
      name: 'final_answer',
      description: 'Deliver the final answer',
      directReturn: true,
      execute: (args: { message: string }) => ({ message: args.message }),
    })
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'final_answer', arguments: { message: 'done!' } }],
      },
    ])
    const agent = new Agent({ model, tools: [finish] })

    const result = await agent.run('go')
    expect(result.output).toBe('done!')
    expect(result.steps).toBe(1)
  })

  it('blocks an immediate repeated identical tool call', async () => {
    let calls = 0
    const noop = defineTool({
      name: 'noop',
      description: 'no-op',
      execute: () => {
        calls++
        return 'ok'
      },
    })
    // Model keeps asking for the same call with identical args.
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'a', name: 'noop', arguments: {} }] },
      { content: '', toolCalls: [{ id: 'b', name: 'noop', arguments: {} }] },
      { content: 'stopped' },
    ])
    const agent = new Agent({ model, tools: [noop], maxSteps: 5 })

    const result = await agent.run('loop')
    expect(result.output).toBe('stopped')
    // Second identical call is blocked before reaching the tool.
    expect(calls).toBe(1)
  })

  it('stops at maxSteps to prevent runaway loops', async () => {
    const ask = defineTool({ name: 'ask', description: 'ask', execute: () => 'again' })
    // Every step requests a (varying) tool call so the loop never settles.
    const model: ScriptedModel = new ScriptedModel(
      Array.from({ length: 10 }, (_, i) => ({
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'ask', arguments: { n: i } }],
      })),
    )
    const agent = new Agent({ model, tools: [ask], maxSteps: 3 })

    const result = await agent.run('go')
    expect(result.steps).toBe(3)
  })

  it('applies a planner to narrow the toolset (use_tools fast-path)', async () => {
    const a = defineTool({ name: 'tool_a', description: 'A', execute: () => 'a' })
    const b = defineTool({ name: 'tool_b', description: 'B', execute: () => 'b' })
    const planner: Planner = {
      name: 'router',
      plan: () => ({ mode: 'use_tools', tools: ['tool_b'] }),
    }
    const model = new ScriptedModel([{ content: 'hi' }])
    const agent = new Agent({ model, tools: [a, b], planner })

    await agent.run('hi')
    const exposed = model.calls[0]?.tools.map((t) => t.name)
    expect(exposed).toEqual(['tool_b'])
  })

  it('resolves tools from a protocol provider', async () => {
    const remote = defineTool({ name: 'remote_tool', description: 'remote', execute: () => 'pong' })
    const provider = defineToolProvider('mock-mcp', [remote])
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'remote_tool', arguments: {} }] },
      { content: 'got pong' },
    ])
    const agent = new Agent({ model, toolProviders: [provider] })

    const result = await agent.run('use remote')
    expect(result.output).toBe('got pong')
    expect(result.toolsInvoked).toEqual(['remote_tool'])
  })

  it('accepts multimodal input (image/audio/...) and carries parts on the user message', async () => {
    const model = new ScriptedModel([{ content: 'a cat' }])
    const agent = new Agent({ model })

    const result = await agent.run([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', source: { url: 'https://example.com/cat.png', mimeType: 'image/png' } },
    ])

    const userMsg = model.calls[0]?.messages.find((m) => m.role === 'user')
    expect(userMsg?.role).toBe('user')
    // Text fallback for text-only consumers (memory, planner, fact search).
    expect(userMsg?.content).toBe('what is in this image?')
    // Full multimodal parts for the LanguageModel adapter to forward.
    expect(userMsg?.parts).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', source: { url: 'https://example.com/cat.png', mimeType: 'image/png' } },
    ])
    expect(result.output).toBe('a cat')
  })

  it('persists the turn to memory and recalls facts into the system prompt', async () => {
    const memory = new InMemoryMemory({ facts: { name: 'Somchai' } })
    const model = new ScriptedModel([{ content: 'hi Somchai' }])
    const agent = new Agent({ model, memory, instructions: 'Be brief.' })

    await agent.run('hello')

    const system = model.calls[0]?.messages[0]
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('Somchai')
    // user + assistant appended.
    expect(memory.loadHistory()).toHaveLength(2)
  })

  it('emits a complete event stream over the run', async () => {
    const events: string[] = []
    const tool = defineTool({ name: 'ping', description: 'ping', execute: () => 'pong' })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }] },
      { content: 'done' },
    ])
    const agent = new Agent({
      model,
      tools: [tool],
      hooks: { onEvent: (e: AgentEvent) => void events.push(e.type) },
    })

    await agent.run('go')

    expect(events).toContain('run_start')
    expect(events).toContain('tool_call')
    expect(events).toContain('tool_result')
    expect(events).toContain('run_end')
  })

  it('auto-registers a remember_fact tool and writes to long-term memory', async () => {
    const memory = new InMemoryMemory()
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'remember_fact', arguments: { key: 'name', value: 'Somchai' } },
        ],
      },
      { content: 'Nice to meet you, Somchai!' },
    ])
    const agent = new Agent({ model, memory, rememberFacts: true })

    await agent.run('My name is Somchai')

    expect(memory.recallFacts()).toEqual({ name: 'Somchai' })
    // The tool was exposed to the model.
    expect(model.calls[0]?.tools.map((t) => t.name)).toContain('remember_fact')
  })

  it('injects only facts relevant to the input via semantic recall', async () => {
    const memory = new InMemoryMemory({
      facts: { allergy: 'allergic to peanuts', hobby: 'enjoys cycling', city: 'lives in Bangkok' },
    })
    const model = new ScriptedModel([{ content: 'ok' }])
    const agent = new Agent({ model, memory, factRecallLimit: 1 })

    await agent.run('any peanuts in this dish?')

    const system = model.calls[0]?.messages[0]?.content ?? ''
    expect(system).toContain('allergic to peanuts')
    expect(system).not.toContain('cycling')
  })

  it('tallies usage across runs via the UsageTracker governance hook', async () => {
    const tracker = new UsageTracker()
    const model = new ScriptedModel([{ content: 'x', usage: { inputTokens: 4, outputTokens: 2 } }])
    const agent = new Agent({ model, hooks: tracker.hooks })

    await agent.run('go')

    expect(tracker.snapshot().runs).toBe(1)
    expect(tracker.snapshot().usage.totalTokens).toBe(6)
  })
})
