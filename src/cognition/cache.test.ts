import { describe, expect, it } from 'bun:test'
import { ScriptedModel } from '../test-support/scripted-model'
import { InMemoryModelCache, cacheModel } from './cache'
import type { GenerateOptions, LanguageModel, ModelResponse } from './model'

const ask = (text: string): GenerateOptions => ({
  messages: [{ role: 'user', content: text }],
  tools: [],
})

describe('cacheModel', () => {
  it('returns the cached response on an identical request (one provider call)', async () => {
    let calls = 0
    const model: LanguageModel = {
      id: 'm',
      generate: () => {
        calls++
        return Promise.resolve({ content: 'answer', usage: { inputTokens: 1, outputTokens: 1 } })
      },
    }
    const cached = cacheModel(model)

    const a = await cached.generate(ask('hi'))
    const b = await cached.generate(ask('hi'))
    expect(a.content).toBe('answer')
    expect(b.content).toBe('answer')
    expect(calls).toBe(1) // second served from cache
  })

  it('misses for a different transcript', async () => {
    const model = new ScriptedModel([{ content: 'one' }, { content: 'two' }])
    const cached = cacheModel(model)
    expect((await cached.generate(ask('a'))).content).toBe('one')
    expect((await cached.generate(ask('b'))).content).toBe('two')
  })

  it('returns a clone so callers cannot mutate the cached entry', async () => {
    const model: LanguageModel = {
      id: 'm',
      generate: () =>
        Promise.resolve({
          content: 'x',
          toolCalls: [{ id: '1', name: 't', arguments: { a: 1 } }],
        }),
    }
    const cached = cacheModel(model)
    const first = await cached.generate(ask('q'))
    ;(first.toolCalls?.[0]?.arguments as { a: number }).a = 999

    const second = await cached.generate(ask('q'))
    expect(second.toolCalls?.[0]?.arguments).toEqual({ a: 1 })
  })

  it('does not expose generateStream (forces the buffered path)', () => {
    expect(cacheModel(new ScriptedModel([])).generateStream).toBeUndefined()
  })

  it('honors a custom key function', async () => {
    let calls = 0
    const model: LanguageModel = {
      id: 'm',
      generate: () => {
        calls++
        return Promise.resolve({ content: `r${calls}` })
      },
    }
    // key ignores the messages → every request collides on one entry
    const cached = cacheModel(model, { key: () => 'fixed' })
    await cached.generate(ask('a'))
    const second = await cached.generate(ask('totally different'))
    expect(second.content).toBe('r1')
    expect(calls).toBe(1)
  })
})

describe('InMemoryModelCache', () => {
  const resp: ModelResponse = { content: 'v' }

  it('stores and retrieves by key', () => {
    const cache = new InMemoryModelCache()
    cache.set('k', resp)
    expect(cache.get('k')).toEqual(resp)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts the oldest entry past maxEntries', () => {
    const cache = new InMemoryModelCache({ maxEntries: 2 })
    cache.set('a', resp)
    cache.set('b', resp)
    cache.set('c', resp) // evicts 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toEqual(resp)
    expect(cache.get('c')).toEqual(resp)
  })

  it('clear() drops everything', () => {
    const cache = new InMemoryModelCache()
    cache.set('k', resp)
    cache.clear()
    expect(cache.get('k')).toBeUndefined()
  })
})
