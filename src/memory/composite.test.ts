import { describe, expect, it } from 'bun:test'
import { composeMemory } from './composite'
import { InMemoryMemory } from './in-memory'
import type { ConversationMemory, FactMemory, MemoryFact } from './memory'

describe('composeMemory', () => {
  it('routes conversation to one backend and facts to another', async () => {
    const conversation = new InMemoryMemory()
    const facts = new InMemoryMemory()
    const memory = composeMemory({ conversation, facts })

    await memory.appendMessage({ role: 'user', content: 'hi' })
    await memory.rememberFact?.('name', 'Decimo')

    // conversation landed only in the conversation backend
    expect((await conversation.loadHistory()).map((m) => m.content)).toEqual(['hi'])
    expect(await facts.loadHistory()).toEqual([])
    // facts landed only in the facts backend
    expect(await facts.recallFacts()).toEqual({ name: 'Decimo' })
    expect(await memory.recallFacts?.()).toEqual({ name: 'Decimo' })
  })

  it('omits fact methods entirely when no fact backend is given', () => {
    const memory = composeMemory({ conversation: new InMemoryMemory() })
    expect(memory.rememberFact).toBeUndefined()
    expect(memory.recallFacts).toBeUndefined()
    expect(memory.searchFacts).toBeUndefined()
  })

  it('forwards searchFacts only when the fact backend implements it', async () => {
    const conversation: ConversationMemory = { loadHistory: () => [], appendMessage: () => {} }
    const searchable: FactMemory = {
      rememberFact: () => {},
      recallFacts: () => ({}),
      searchFacts: (query): MemoryFact[] => [{ key: 'q', value: query, score: 1 }],
    }
    const memory = composeMemory({ conversation, facts: searchable })
    expect(await memory.searchFacts?.('hello')).toEqual([{ key: 'q', value: 'hello', score: 1 }])

    const plain = composeMemory({
      conversation,
      facts: { rememberFact: () => {}, recallFacts: () => ({}) },
    })
    expect(plain.searchFacts).toBeUndefined()
  })
})
