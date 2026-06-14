import { describe, expect, it } from 'bun:test'
import { InMemoryMemory } from './in-memory'

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

  it('stores and recalls facts', () => {
    const memory = new InMemoryMemory()
    memory.rememberFact('hobby', 'cycling')
    memory.rememberFact('hobby', 'running') // overwrite
    expect(memory.recallFacts()).toEqual({ hobby: 'running' })
  })
})
