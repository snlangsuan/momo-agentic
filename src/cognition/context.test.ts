import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, type Message, approxTokenCounter, fitContext } from '../index'
import { InMemoryMemory } from '../memory/in-memory'
import { ScriptedModel } from '../test-support/scripted-model'

// A counter where every message costs exactly 1 token, for easy arithmetic.
const oneEach = { count: () => 1 }

const msg = (role: Message['role'], content: string): Message => ({ role, content })

describe('fitContext', () => {
  it('returns the transcript unchanged when it already fits', () => {
    const messages = [msg('system', 'sys'), msg('user', 'hi')]
    expect(fitContext(messages, { counter: oneEach, limit: 10 })).toBe(messages)
  })

  it('drops the oldest non-system messages first, keeping system and the last', () => {
    const messages = [
      msg('system', 'sys'),
      msg('user', 'old-1'),
      msg('assistant', 'old-2'),
      msg('user', 'recent'),
    ]
    // limit 2 → must keep system + last (2 tokens), drop both middle messages.
    const fitted = fitContext(messages, { counter: oneEach, limit: 2 })
    expect(fitted.map((m) => m.content)).toEqual(['sys', 'recent'])
  })

  it('never drops the system message or the current (last) message', () => {
    const messages = [msg('system', 'sys'), msg('user', 'current')]
    // Even with an impossible limit, the protected messages survive.
    const fitted = fitContext(messages, { counter: oneEach, limit: 0 })
    expect(fitted.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('approxTokenCounter estimates ~4 chars per token', () => {
    expect(approxTokenCounter.count('12345678')).toBe(2)
  })
})

describe('Agent contextLimit', () => {
  it('trims old history before the model call and emits context_trimmed', async () => {
    // Seed a long history so the transcript exceeds the limit.
    const seed: Message[] = [
      msg('user', 'turn 1'),
      msg('assistant', 'reply 1'),
      msg('user', 'turn 2'),
      msg('assistant', 'reply 2'),
    ]
    const memory = new InMemoryMemory({ messages: seed })
    const model = new ScriptedModel([{ content: 'ok' }])
    const events: AgentEvent[] = []

    await new Agent({
      model,
      memory,
      contextLimit: 2, // counter default ~4 chars/token; only the newest survive
      tokenCounter: oneEach,
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('newest question')

    // The oldest turns were dropped before the model saw them; newest kept.
    // (calls[0].messages is the live array the strategy appends to, so assert by content.)
    const seen = model.calls[0]?.messages.map((m) => m.content) ?? []
    expect(seen).not.toContain('turn 1')
    expect(seen).not.toContain('reply 1')
    expect(seen).toContain('newest question')
    const trimmed = events.find((e) => e.type === 'context_trimmed')
    expect(trimmed).toBeDefined()
    expect((trimmed as { dropped: number }).dropped).toBeGreaterThan(0)
  })

  it('does not trim or emit when under the limit', async () => {
    const model = new ScriptedModel([{ content: 'ok' }])
    const events: AgentEvent[] = []
    await new Agent({
      model,
      contextLimit: 1000,
      tokenCounter: oneEach,
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('hi')
    expect(events.some((e) => e.type === 'context_trimmed')).toBe(false)
  })
})
