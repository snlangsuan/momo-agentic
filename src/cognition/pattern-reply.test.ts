import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, type PatternReply, matchPatternReply } from '@/index'
import { InMemoryMemory } from '@/memory/in-memory'
import { ScriptedModel } from '@/test-support/scripted-model'

const model = () => new ScriptedModel([{ content: 'from the model' }])

describe('matchPatternReply', () => {
  it('matches an exact string against the trimmed input', () => {
    const replies: PatternReply[] = [{ pattern: 'ping', reply: 'pong' }]
    expect(matchPatternReply('ping', replies)?.reply).toBe('pong')
    expect(matchPatternReply('  ping\n', replies)?.reply).toBe('pong')
    expect(matchPatternReply('ping me', replies)).toBeUndefined()
  })

  it('is case-sensitive for exact strings (use a RegExp for looser matching)', () => {
    const replies: PatternReply[] = [{ pattern: 'ping', reply: 'pong' }]
    expect(matchPatternReply('Ping', replies)).toBeUndefined()
    expect(matchPatternReply('Ping', [{ pattern: /^ping$/i, reply: 'pong' }])?.reply).toBe('pong')
  })

  it('matches a RegExp anywhere in the input', () => {
    const replies: PatternReply[] = [{ pattern: /\bhelp\b/, reply: 'the manual' }]
    expect(matchPatternReply('i need help please', replies)?.reply).toBe('the manual')
    expect(matchPatternReply('helpless', replies)).toBeUndefined()
  })

  it('returns the FIRST match in list order', () => {
    const replies: PatternReply[] = [
      { pattern: /^hi/, reply: 'first' },
      { pattern: 'hi there', reply: 'second' },
    ]
    expect(matchPatternReply('hi there', replies)?.reply).toBe('first')
  })

  it('keeps matching a global RegExp on every call (lastIndex is reset)', () => {
    // A `g` pattern advances `lastIndex` on `test`, so an unreset one would
    // match only every other turn.
    const replies: PatternReply[] = [{ pattern: /ping/g, reply: 'pong' }]
    expect(matchPatternReply('ping', replies)?.reply).toBe('pong')
    expect(matchPatternReply('ping', replies)?.reply).toBe('pong')
    expect(matchPatternReply('ping', replies)?.reply).toBe('pong')
  })

  it('returns undefined when nothing matches or there are no rules', () => {
    expect(matchPatternReply('anything', [])).toBeUndefined()
    expect(matchPatternReply('anything', [{ pattern: 'x', reply: 'y' }])).toBeUndefined()
  })
})

describe('Agent patternReplies', () => {
  it('answers from the pattern and never calls the model', async () => {
    const scripted = model()
    const agent = new Agent({
      model: scripted,
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    const result = await agent.run('ping')

    expect(result.output).toBe('pong')
    expect(scripted.calls).toHaveLength(0)
    expect(result.steps).toBe(0)
    expect(result.trace).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.usageByModel).toEqual({})
    expect(result.toolsInvoked).toEqual([])
    expect(result.skillsUsed).toEqual([])
  })

  it('falls through to the model when nothing matches', async () => {
    const scripted = model()
    const agent = new Agent({
      model: scripted,
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    const result = await agent.run('something else')

    expect(result.output).toBe('from the model')
    expect(scripted.calls).toHaveLength(1)
  })

  it('returns an object reply raw on returns[0] with its JSON on output', async () => {
    const card = { type: 'card', title: 'Commands', items: ['/help', '/start'] }
    const agent = new Agent({
      model: model(),
      patternReplies: [{ pattern: /^\/help$/, reply: card }],
    })

    const result = await agent.run('/help')

    expect(result.returns).toEqual([card])
    expect(result.returns[0]).toBe(card) // the object itself, not a copy
    expect(result.output).toBe(JSON.stringify(card))
    expect(result.object).toBeUndefined()
  })

  it('emits pattern_reply, output, usage and run_end events', async () => {
    const events: AgentEvent[] = []
    const agent = new Agent({
      model: model(),
      hooks: { onEvent: (e) => void events.push(e) },
      patternReplies: [{ pattern: /^\/help$/, name: 'help-menu', reply: { ok: true } }],
    })

    await agent.run('/help')

    expect(events.map((e) => e.type)).toEqual([
      'run_start',
      'pattern_reply',
      'output',
      'usage',
      'run_end',
    ])
    expect(events[1]).toEqual({
      type: 'pattern_reply',
      agent: 'agent',
      pattern: '/^\\/help$/',
      name: 'help-menu',
    })
    // The raw object rides the output event — consumers render from it directly.
    expect(events[2]).toEqual({ type: 'output', agent: 'agent', value: { ok: true }, final: true })
  })

  it('omits the event name when the rule has none', async () => {
    const events: AgentEvent[] = []
    const agent = new Agent({
      model: model(),
      hooks: { onEvent: (e) => void events.push(e) },
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    await agent.run('ping')

    expect(events[1]).toEqual({ type: 'pattern_reply', agent: 'agent', pattern: 'ping' })
  })

  it('records the canned turn in conversation memory', async () => {
    const memory = new InMemoryMemory()
    const agent = new Agent({
      model: model(),
      memory,
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    await agent.run('ping')

    expect(memory.loadHistory()).toEqual([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ])
  })

  it('runs input guardrails BEFORE the pattern check', async () => {
    const agent = new Agent({
      model: model(),
      inputGuardrails: [{ name: 'block-all', check: () => ({ pass: false, output: 'blocked' }) }],
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    expect((await agent.run('ping')).output).toBe('blocked')
  })

  it('never resolves tool providers for a canned turn', async () => {
    let listed = 0
    const agent = new Agent({
      model: model(),
      toolProviders: [
        {
          name: 'remote',
          listTools: () => {
            listed++
            return []
          },
        },
      ],
      patternReplies: [{ pattern: 'ping', reply: 'pong' }],
    })

    await agent.run('ping')
    expect(listed).toBe(0)

    await agent.run('not a pattern')
    expect(listed).toBe(1)
  })
})
