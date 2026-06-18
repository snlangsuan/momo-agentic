import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel, defineTool } from '../index'
import { InMemoryRunStore } from './run-store'

describe('InMemoryRunStore', () => {
  it('saves, loads (deep copy), and deletes checkpoints', () => {
    const store = new InMemoryRunStore()
    const checkpoint = {
      runId: 'r1',
      input: 'hi',
      messages: [{ role: 'user' as const, content: 'hi' }],
      step: 1,
      toolsInvoked: ['t'],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      status: 'running' as const,
    }
    store.save(checkpoint)

    const loaded = store.load('r1')
    expect(loaded).toEqual(checkpoint)
    // Deep copy: mutating the original doesn't change the stored snapshot.
    checkpoint.messages[0]!.content = 'changed'
    expect(store.load('r1')?.messages[0]?.content).toBe('hi')

    store.delete('r1')
    expect(store.load('r1')).toBeUndefined()
  })
})

describe('Agent — durable runs', () => {
  it('checkpoints each step and resumes a crashed run without re-running finished tools', async () => {
    let toolRuns = 0
    const tool = defineTool({
      name: 'lookup',
      description: 'l',
      execute: () => {
        toolRuns++
        return 'the answer is 42'
      },
    })
    const store = new InMemoryRunStore()

    // Run 1: step 1 asks for the tool; step 2's model call "crashes".
    let call = 0
    const crashingModel: LanguageModel = {
      id: 'crash',
      generate: () => {
        call++
        if (call === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{ id: '1', name: 'lookup', arguments: {} }],
          })
        }
        return Promise.reject(new Error('boom'))
      },
    }

    await expect(
      new Agent({ model: crashingModel, tools: [tool], runStore: store }).run('q', {
        runId: 'job-1',
      }),
    ).rejects.toThrow('boom')

    // A checkpoint survived at step 1, with the tool result already in the transcript.
    const saved = store.load('job-1')
    expect(saved?.step).toBe(1)
    expect(saved?.toolsInvoked).toEqual(['lookup'])
    expect(saved?.messages.some((m) => m.role === 'tool' && m.content === 'the answer is 42')).toBe(
      true,
    )
    expect(toolRuns).toBe(1)

    // Run 2: a fresh model resumes and finishes — the tool is NOT called again.
    const finishingModel: LanguageModel = {
      id: 'finish',
      generate: () => Promise.resolve({ content: 'The answer is 42.' }),
    }
    const result = await new Agent({
      model: finishingModel,
      tools: [tool],
      runStore: store,
    }).run('q', { runId: 'job-1', resume: true })

    expect(result.output).toBe('The answer is 42.')
    expect(toolRuns).toBe(1) // still once — resumed from the saved transcript
    expect(store.load('job-1')).toBeUndefined() // deleted on success
  })

  it('does not checkpoint when no runId is given', async () => {
    const store = new InMemoryRunStore()
    const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'hi' }) }
    await new Agent({ model, runStore: store }).run('q') // no runId
    expect(store.load('anything')).toBeUndefined()
  })

  it('runs fresh when resume is requested but no checkpoint exists', async () => {
    const store = new InMemoryRunStore()
    const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'fresh' }) }
    const result = await new Agent({ model, runStore: store }).run('q', {
      runId: 'missing',
      resume: true,
    })
    expect(result.output).toBe('fresh')
  })
})
