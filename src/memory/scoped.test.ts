import { describe, expect, it } from 'bun:test'
import { Agent } from '../agent/agent'
import { ScriptedModel } from '../test-support/scripted-model'
import { MemoryStore } from './scoped'

describe('MemoryStore — multi-user / multi-thread scoping', () => {
  it('isolates conversation per (userId, threadId)', async () => {
    const store = new MemoryStore()
    const t1 = store.for({ userId: 'u1', threadId: 't1' })
    const t2 = store.for({ userId: 'u1', threadId: 't2' })

    await t1.appendMessage({ role: 'user', content: 'hi from t1' })
    await t2.appendMessage({ role: 'user', content: 'hi from t2' })

    expect((await t1.loadHistory()).map((m) => m.content)).toEqual(['hi from t1'])
    expect((await t2.loadHistory()).map((m) => m.content)).toEqual(['hi from t2'])
  })

  it('shares long-term facts across a user’s threads but isolates them per user', async () => {
    const store = new MemoryStore()
    await store.for({ userId: 'u1', threadId: 't1' }).rememberFact?.('city', 'Bangkok')

    // Same user, a different thread → sees the fact.
    expect(store.for({ userId: 'u1', threadId: 't2' }).recallFacts?.()).toEqual({ city: 'Bangkok' })
    // Different user → isolated.
    expect(store.for({ userId: 'u2', threadId: 't1' }).recallFacts?.()).toEqual({})
  })

  it('memoizes the underlying stores so repeated for() calls reuse them', async () => {
    const store = new MemoryStore()
    await store.for({ userId: 'u1', threadId: 't1' }).appendMessage({ role: 'user', content: 'x' })
    // A fresh composed Memory for the same scope still reads the cached transcript.
    expect((await store.for({ userId: 'u1', threadId: 't1' }).loadHistory()).length).toBe(1)
  })

  it('forwards semantic searchFacts when the fact store supports it', () => {
    const store = new MemoryStore()
    expect(typeof store.for({ userId: 'u1', threadId: 't1' }).searchFacts).toBe('function')
  })

  it('omits the fact tier entirely when facts: null (conversation-only)', () => {
    const store = new MemoryStore({ facts: null })
    const mem = store.for({ userId: 'u1', threadId: 't1' })
    expect(mem.rememberFact).toBeUndefined()
    expect(mem.recallFacts).toBeUndefined()
    expect(mem.searchFacts).toBeUndefined()
  })

  it('accepts custom per-tier factories, called once per scope/user', () => {
    const convoScopes: string[] = []
    const factUsers: string[] = []
    const store = new MemoryStore({
      conversation: (scope) => {
        convoScopes.push(`${scope.userId}/${scope.threadId}`)
        return { loadHistory: () => [], appendMessage: () => {} }
      },
      facts: (userId) => {
        factUsers.push(userId)
        return { rememberFact: () => {}, recallFacts: () => ({}) }
      },
    })

    store.for({ userId: 'u1', threadId: 't1' })
    store.for({ userId: 'u1', threadId: 't1' }) // cached — no new factory calls
    store.for({ userId: 'u1', threadId: 't2' }) // new thread, same user's facts
    store.for({ userId: 'u2', threadId: 't1' })

    expect(convoScopes).toEqual(['u1/t1', 'u1/t2', 'u2/t1'])
    expect(factUsers).toEqual(['u1', 'u2'])
  })
})

describe('Agent.withMemory — per-scope agents from one base', () => {
  it('forks a thin agent per scope; threads keep separate transcripts', async () => {
    const store = new MemoryStore()
    const model = new ScriptedModel([{ content: 'reply-1' }, { content: 'reply-2' }])
    const base = new Agent({ model })

    await base.withMemory(store.for({ userId: 'u1', threadId: 't1' })).run('first')
    await base.withMemory(store.for({ userId: 'u1', threadId: 't2' })).run('second')

    expect(
      (await store.for({ userId: 'u1', threadId: 't1' }).loadHistory()).map((m) => m.content),
    ).toEqual(['first', 'reply-1'])
    expect(
      (await store.for({ userId: 'u1', threadId: 't2' }).loadHistory()).map((m) => m.content),
    ).toEqual(['second', 'reply-2'])
  })
})
