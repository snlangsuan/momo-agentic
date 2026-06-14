/**
 * Regression / contract suite.
 *
 * Locks behavioral invariants that existing users rely on, plus a full-stack
 * integration that exercises many features at once. Adding a feature should keep
 * all of these green; if a change breaks one, that's a real regression to weigh
 * deliberately (and update here if the change is intended).
 */
import { describe, expect, it } from 'bun:test'
import {
  Agent,
  type AgentEvent,
  InMemoryMemory,
  combineHooks,
  defineSkill,
  defineTool,
  defineToolProvider,
} from './index'
import { ScriptedModel } from './test-support/scripted-model'

describe('contract: RunResult shape', () => {
  it('always returns every documented field', async () => {
    const result = await new Agent({ model: new ScriptedModel([{ content: 'hi' }]) }).run('x')
    expect(Object.keys(result).sort()).toEqual(
      ['messages', 'output', 'skillsUsed', 'steps', 'toolsInvoked', 'usage'].sort(),
    )
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.skillsUsed).toEqual([])
    expect(result.toolsInvoked).toEqual([])
  })
})

describe('contract: defaults are stable', () => {
  it('defaults maxSteps to 10', async () => {
    const noop = defineTool({ name: 'noop', description: 'n', execute: () => 'again' })
    // A model that always requests a (varying) tool call so the loop never settles.
    const model = new ScriptedModel(
      Array.from({ length: 15 }, (_, i) => ({
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'noop', arguments: { n: i } }],
      })),
    )
    const result = await new Agent({ model, tools: [noop] }).run('go')
    expect(result.steps).toBe(10)
  })

  it('defaults a tool with no parameters to an empty object schema', () => {
    const t = defineTool({ name: 't', description: 'd', execute: () => 'x' })
    expect(t.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('defaults the agent name to "agent"', async () => {
    const events: AgentEvent[] = []
    await new Agent({
      model: new ScriptedModel([{ content: 'ok' }]),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('x')
    expect(events[0]?.agent).toBe('agent')
  })
})

describe('contract: directReturn short-circuits the loop', () => {
  it('returns the tool message as the final output in one step', async () => {
    const final = defineTool<{ message: string }>({
      name: 'final',
      description: 'final',
      directReturn: true,
      execute: ({ message }) => ({ message }),
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'final', arguments: { message: 'done' } }] },
    ])
    const result = await new Agent({ model, tools: [final] }).run('go')
    expect(result.output).toBe('done')
    expect(result.steps).toBe(1)
  })
})

describe('contract: event stream ordering & shape', () => {
  it('starts with run_start, ends with run_end, and pairs tool_call before tool_result', async () => {
    const tool = defineTool({ name: 'ping', description: 'p', execute: () => 'pong' })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }] },
      { content: 'done' },
    ])
    const events: AgentEvent[] = []
    await new Agent({ model, tools: [tool], hooks: { onEvent: (e) => void events.push(e) } }).run(
      'go',
    )

    const types = events.map((e) => e.type)
    expect(types[0]).toBe('run_start')
    expect(types.at(-1)).toBe('run_end')
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('tool_result'))

    const usage = events.find((e) => e.type === 'usage')
    // The usage event must carry both tools and skills arrays (skills added later).
    expect(usage).toMatchObject({ tools: ['ping'], skills: [] })
  })
})

describe('contract: combineHooks isolates a throwing listener', () => {
  it('a failing listener does not break the run or sibling listeners', async () => {
    const seen: string[] = []
    const bad = {
      onEvent: () => {
        throw new Error('boom')
      },
    }
    const good = { onEvent: (e: AgentEvent) => void seen.push(e.type) }
    const agent = new Agent({
      model: new ScriptedModel([{ content: 'ok' }]),
      hooks: combineHooks(bad, good),
    })
    const result = await agent.run('x') // must not throw
    expect(result.output).toBe('ok')
    expect(seen).toContain('run_end')
  })
})

describe('integration: many features at once still cooperate', () => {
  it('tools + skills + provider + memory + hooks compose correctly', async () => {
    const calc = defineTool<{ a: number; b: number }>({
      name: 'calc',
      description: 'add',
      execute: ({ a, b }) => a + b,
    })
    const weatherSkill = defineSkill({
      name: 'weather',
      description: 'weather',
      instruction: 'Use get_weather for weather questions.',
      tools: [defineTool({ name: 'get_weather', description: 'w', execute: () => 'sunny' })],
    })
    const provider = defineToolProvider('remote', [
      defineTool({ name: 'remote_ping', description: 'r', execute: () => 'pong' }),
    ])
    const memory = new InMemoryMemory()

    // The model uses a skill tool, a provider tool, writes a fact, then answers.
    const model = new ScriptedModel([
      {
        content: 'working',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      { content: '', toolCalls: [{ id: 'c2', name: 'remote_ping', arguments: {} }] },
      {
        content: '',
        toolCalls: [
          { id: 'c3', name: 'remember_fact', arguments: { key: 'mood', value: 'happy' } },
        ],
      },
      { content: 'All done.', usage: { inputTokens: 8, outputTokens: 4 } },
    ])

    const events: string[] = []
    const agent = new Agent({
      model,
      tools: [calc],
      skills: [weatherSkill],
      toolProviders: [provider],
      memory,
      rememberFacts: true,
      hooks: { onEvent: (e) => void events.push(e.type) },
    })

    const result = await agent.run('do everything')

    // Every kind of tool was reachable and used.
    expect(result.toolsInvoked).toEqual(['get_weather', 'remote_ping', 'remember_fact'])
    // Skill attribution works.
    expect(result.skillsUsed).toEqual(['weather'])
    // Long-term memory was written via the auto remember_fact tool.
    expect(memory.recallFacts()).toEqual({ mood: 'happy' })
    // Conversation persisted (user + assistant).
    expect(memory.loadHistory()).toHaveLength(2)
    // Usage accumulated across steps.
    expect(result.usage.totalTokens).toBe(24)
    // Output is the final assistant text.
    expect(result.output).toBe('All done.')
    // Full event lifecycle fired.
    expect(events[0]).toBe('run_start')
    expect(events).toContain('run_end')
  })
})
