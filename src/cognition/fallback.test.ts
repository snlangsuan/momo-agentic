import { describe, expect, it } from 'bun:test'
import { withFallback } from '@/cognition/fallback'
import type {
  GenerateOptions,
  LanguageModel,
  ModelResponse,
  ModelStreamChunk,
} from '@/cognition/model'

/** A model whose `generate` either returns a fixed response or throws. */
function model(id: string, behavior: ModelResponse | Error): LanguageModel {
  return {
    id,
    generate: () =>
      behavior instanceof Error ? Promise.reject(behavior) : Promise.resolve(behavior),
  }
}

const opts: GenerateOptions = { messages: [], tools: [] }

describe('withFallback', () => {
  it('returns the primary model result when it succeeds', async () => {
    const m = withFallback([model('a', { content: 'from a' }), model('b', { content: 'from b' })])
    expect(await m.generate(opts)).toEqual({ content: 'from a' })
  })

  it('falls through to the next model on error', async () => {
    const m = withFallback([model('a', new Error('boom')), model('b', { content: 'from b' })])
    expect(await m.generate(opts)).toEqual({ content: 'from b' })
  })

  it('reports a stable id (the primary by default) and an override', async () => {
    expect(withFallback([model('a', { content: '' }), model('b', { content: '' })]).id).toBe('a')
    expect(withFallback([model('a', { content: '' })], { id: 'chain' }).id).toBe('chain')
  })

  it('calls onFallback with from/to ids as it advances', async () => {
    const seen: Array<{ from: string; to: string }> = []
    const m = withFallback(
      [model('a', new Error('x')), model('b', new Error('y')), model('c', { content: 'ok' })],
      {
        onFallback: ({ from, to }) => seen.push({ from, to }),
      },
    )
    expect(await m.generate(opts)).toEqual({ content: 'ok' })
    expect(seen).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])
  })

  it('throws the last error when every model fails', async () => {
    const m = withFallback([model('a', new Error('first')), model('b', new Error('last'))])
    expect(m.generate(opts)).rejects.toThrow('last')
  })

  it('does not fall back when fallbackIf rejects the error', async () => {
    const m = withFallback([model('a', new Error('keep')), model('b', { content: 'unused' })], {
      fallbackIf: () => false,
    })
    expect(m.generate(opts)).rejects.toThrow('keep')
  })

  it('does not fall back on an abort by default', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const m = withFallback([model('a', abort), model('b', { content: 'unused' })])
    expect(m.generate(opts)).rejects.toThrow('aborted')
  })

  it('streams from the next model when the first fails before any token', async () => {
    // The first model can't stream and its generate rejects → the streaming path
    // falls through to the second model, which streams normally.
    const failing = model('a', new Error('no stream'))
    const ok: LanguageModel = {
      id: 'b',
      generate: () => Promise.resolve({ content: 'hi' }),
      async *generateStream(): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
        yield { delta: 'hi' }
        return { content: 'hi' }
      },
    }
    const m = withFallback([failing, ok])
    const gen = m.generateStream?.(opts)
    if (!gen) throw new Error('expected generateStream')
    const deltas: string[] = []
    let next = await gen.next()
    while (!next.done) {
      deltas.push(next.value.delta)
      next = await gen.next()
    }
    expect(deltas).toEqual(['hi'])
    expect(next.value).toEqual({ content: 'hi' })
  })

  it('throws on an empty model list', () => {
    expect(() => withFallback([])).toThrow('at least one model')
  })
})
