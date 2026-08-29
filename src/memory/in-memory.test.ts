import { describe, expect, it } from 'bun:test'
import { InMemoryMemory } from '@/memory/in-memory'

describe('InMemoryMemory', () => {
  it('appends and loads conversation messages in order', () => {
    const memory = new InMemoryMemory()
    memory.appendMessage({ role: 'user', content: 'a' })
    memory.appendMessage({ role: 'assistant', content: 'b' })

    expect(memory.loadHistory().map((m) => m.content)).toEqual(['a', 'b'])
  })

  it('honors the limit option', () => {
    const memory = new InMemoryMemory({
      messages: [
        { role: 'user', content: '1' },
        { role: 'assistant', content: '2' },
        { role: 'user', content: '3' },
      ],
    })
    expect(memory.loadHistory({ limit: 2 }).map((m) => m.content)).toEqual(['2', '3'])
  })

  it('searchFacts reflects an overwritten fact value', () => {
    const memory = new InMemoryMemory()
    memory.rememberFact('hobby', 'cycling')
    expect(memory.searchFacts('cycling')).toEqual([{ key: 'hobby', value: 'cycling', score: 1 }])
    memory.rememberFact('hobby', 'running')
    // Fact tokens are memoized per fact — an overwrite must invalidate them.
    expect(memory.searchFacts('cycling')).toEqual([])
    expect(memory.searchFacts('running')).toEqual([{ key: 'hobby', value: 'running', score: 1 }])
  })

  it('stores and recalls facts', () => {
    const memory = new InMemoryMemory()
    memory.rememberFact('hobby', 'cycling')
    memory.rememberFact('hobby', 'running') // overwrite
    expect(memory.recallFacts()).toEqual({ hobby: 'running' })
  })
})
