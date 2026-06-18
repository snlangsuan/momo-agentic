import { describe, expect, it } from 'bun:test'
import { formatFacts, recallRelevantFacts } from './facts'
import { InMemoryMemory } from './in-memory'
import type { FactMemory, MemoryFact } from './memory'

describe('formatFacts', () => {
  it('renders a fact list as a bullet list', () => {
    const facts: MemoryFact[] = [
      { key: 'name', value: 'Somchai' },
      { key: 'hobby', value: 'cycling' },
    ]
    expect(formatFacts(facts)).toBe('- name: Somchai\n- hobby: cycling')
  })

  it('accepts a raw key→value map', () => {
    expect(formatFacts({ name: 'Somchai' })).toBe('- name: Somchai')
  })

  it('returns an empty string when there are no facts', () => {
    expect(formatFacts([])).toBe('')
    expect(formatFacts({})).toBe('')
  })
})

describe('recallRelevantFacts', () => {
  it('returns all facts when the set fits within the limit', async () => {
    const memory = new InMemoryMemory({ facts: { name: 'Somchai', hobby: 'cycling' } })
    const facts = await recallRelevantFacts(memory, 'anything', { limit: 8 })
    expect(facts).toHaveLength(2)
  })

  it('falls back to semantic search when facts exceed the limit', async () => {
    const memory = new InMemoryMemory({
      facts: { name: 'Somchai', hobby: 'cycling', allergy: 'peanuts', city: 'Bangkok' },
    })
    const facts = await recallRelevantFacts(memory, 'cycling hobby', { limit: 2 })
    expect(facts.length).toBeLessThanOrEqual(2)
    expect(facts[0]?.key).toBe('hobby')
  })

  it('slices without ranking when the backend has no searchFacts', async () => {
    const memory: FactMemory = {
      rememberFact() {},
      recallFacts: () => ({ a: '1', b: '2', c: '3' }),
    }
    const facts = await recallRelevantFacts(memory, 'q', { limit: 2 })
    expect(facts).toHaveLength(2)
  })

  it('uses semantic search when only searchFacts is available', async () => {
    const searchOnly: Pick<FactMemory, 'searchFacts'> = {
      searchFacts: (_q, opts) => [{ key: 'hit', value: 'v', score: 1 }].slice(0, opts?.limit),
    }
    const facts = await recallRelevantFacts(searchOnly, 'q')
    expect(facts).toEqual([{ key: 'hit', value: 'v', score: 1 }])
  })

  it('returns nothing when the backend supports neither method', async () => {
    expect(await recallRelevantFacts({}, 'q')).toEqual([])
  })
})
