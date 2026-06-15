import { describe, expect, it } from 'bun:test'
import { Agent, AgentError, type LanguageModel, withRetry } from '../index'

const noDelay = { delayMs: () => 0 }

describe('withRetry', () => {
  it('retries a failing generate() until it succeeds', async () => {
    let attempts = 0
    const flaky: LanguageModel = {
      id: 'flaky',
      generate: () => {
        attempts++
        if (attempts < 3) return Promise.reject(new Error('503 rate limited'))
        return Promise.resolve({ content: 'recovered' })
      },
    }
    const result = await new Agent({ model: withRetry(flaky, { retries: 3, ...noDelay }) }).run(
      'go',
    )
    expect(attempts).toBe(3)
    expect(result.output).toBe('recovered')
  })

  it('gives up after the retry budget and surfaces the error', async () => {
    let attempts = 0
    const dead: LanguageModel = {
      id: 'dead',
      generate: () => {
        attempts++
        return Promise.reject(new Error('always down'))
      },
    }
    await expect(
      new Agent({ model: withRetry(dead, { retries: 2, ...noDelay }) }).run('go'),
    ).rejects.toBeInstanceOf(AgentError)
    expect(attempts).toBe(3) // initial try + 2 retries
  })

  it('does not retry when retryIf returns false', async () => {
    let attempts = 0
    const model: LanguageModel = {
      id: 'fatal',
      generate: () => {
        attempts++
        return Promise.reject(new Error('bad request'))
      },
    }
    const wrapped = withRetry(model, { retries: 5, retryIf: () => false, ...noDelay })
    await expect(new Agent({ model: wrapped }).run('go')).rejects.toBeInstanceOf(AgentError)
    expect(attempts).toBe(1)
  })

  it('preserves streaming and retries a failure before the first token', async () => {
    let attempts = 0
    const model: LanguageModel = {
      id: 'flaky-stream',
      generate: () => Promise.resolve({ content: 'x' }),
      async *generateStream() {
        attempts++
        if (attempts < 2) throw new Error('connection reset')
        yield { delta: 'streamed ' }
        yield { delta: 'answer' }
        return { content: 'streamed answer' }
      },
    }
    const tokens: string[] = []
    const result = await new Agent({
      model: withRetry(model, { retries: 2, ...noDelay }),
      hooks: { onEvent: (e) => void (e.type === 'token' && tokens.push(e.delta)) },
    }).run('go')

    expect(attempts).toBe(2)
    expect(tokens).toEqual(['streamed ', 'answer'])
    expect(result.output).toBe('streamed answer')
  })
})

describe('per-run timeout', () => {
  it('aborts the run and raises an AgentError tagged "timeout"', async () => {
    // A model that never resolves until aborted.
    const hang: LanguageModel = {
      id: 'hang',
      generate: (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
        }),
    }
    try {
      await new Agent({ model: hang, timeoutMs: 50 }).run('go')
      throw new Error('expected the run to time out')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError)
      expect((error as AgentError).stage).toBe('timeout')
    }
  })

  it('does not time out a fast run', async () => {
    const fast: LanguageModel = {
      id: 'fast',
      generate: () => Promise.resolve({ content: 'quick' }),
    }
    const result = await new Agent({ model: fast, timeoutMs: 1000 }).run('go')
    expect(result.output).toBe('quick')
  })
})
