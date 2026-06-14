import { describe, expect, it } from 'bun:test'
import type { Message } from '../shared/types'
import { defineTool } from '../tooling/tool'
import { InMemoryMemory } from './in-memory'
import { createRememberTool } from './remember-tool'
import { type Summarizer, SummarizingMemory } from './summarizing-memory'

describe('InMemoryMemory long-term facts', () => {
  it('ranks facts by keyword overlap via searchFacts', () => {
    const memory = new InMemoryMemory({
      facts: {
        hobby: 'enjoys cycling on weekends',
        allergy: 'allergic to peanuts',
        job: 'software engineer',
      },
    })

    const hits = memory.searchFacts('what should I cook given the allergy?', { limit: 2 })
    expect(hits[0]?.key).toBe('allergy')
    expect(hits.every((h) => (h.score ?? 0) > 0)).toBe(true)
  })

  it('returns nothing for an empty query', () => {
    const memory = new InMemoryMemory({ facts: { a: 'b' } })
    expect(memory.searchFacts('')).toEqual([])
  })
})

describe('createRememberTool', () => {
  it('writes a fact into the backing memory', async () => {
    const memory = new InMemoryMemory()
    const tool = createRememberTool(memory)

    const result = await tool.execute(
      { key: 'name', value: 'Somchai' },
      { agentName: 'a', metadata: {} },
    )

    expect(memory.recallFacts()).toEqual({ name: 'Somchai' })
    expect(result).toMatchObject({ message: expect.stringContaining('Somchai') })
  })
})

describe('SummarizingMemory', () => {
  const summarizer: Summarizer = {
    summarize: (messages) => `summary of ${messages.length} messages`,
  }

  it('passes through history below the threshold', async () => {
    const inner = new InMemoryMemory({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    })
    const memory = new SummarizingMemory(inner, { summarizer, threshold: 5, keepRecent: 2 })

    const history = await memory.loadHistory()
    expect(history).toHaveLength(2)
  })

  it('compresses older messages into a summary, keeping recent verbatim', async () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }))
    const inner = new InMemoryMemory({ messages })
    const memory = new SummarizingMemory(inner, { summarizer, threshold: 6, keepRecent: 3 })

    const history = await memory.loadHistory()
    // 1 summary message + 3 recent.
    expect(history).toHaveLength(4)
    expect(history[0]?.role).toBe('system')
    expect(history[0]?.content).toContain('summary of 7 messages')
    expect(history.slice(1).map((m) => m.content)).toEqual(['m7', 'm8', 'm9'])
  })

  it('honors the limit option after summarizing', async () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }))
    const memory = new SummarizingMemory(new InMemoryMemory({ messages }), {
      summarizer,
      threshold: 6,
      keepRecent: 3,
    })
    // Without a limit: 1 summary + 3 recent = 4. With limit 2: last 2 of those.
    const limited = await memory.loadHistory({ limit: 2 })
    expect(limited.map((m) => m.content)).toEqual(['m8', 'm9'])
  })

  it('delegates conversation and fact methods to the inner store', async () => {
    const inner = new InMemoryMemory({ facts: { name: 'Somchai' } })
    const memory = new SummarizingMemory(inner, { summarizer })

    memory.appendMessage({ role: 'user', content: 'hello' })
    expect(inner.loadHistory().map((m) => m.content)).toEqual(['hello'])

    memory.rememberFact('hobby', 'cycling')
    expect(inner.recallFacts()).toEqual({ name: 'Somchai', hobby: 'cycling' })
    const hits = await memory.searchFacts('cycling')
    expect(hits[0]?.key).toBe('hobby')
  })
})

describe('agent reference: a remember tool plus a normal tool coexist', () => {
  it('keeps tool identity stable', () => {
    const memory = new InMemoryMemory()
    const remember = createRememberTool(memory)
    const other = defineTool({ name: 'noop', description: 'x', execute: () => 'ok' })
    expect(remember.name).toBe('remember_fact')
    expect(other.name).toBe('noop')
  })
})
