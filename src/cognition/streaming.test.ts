import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, type LanguageModel, type ModelResponse } from '@/index'

/** A model that streams its text word-by-word, then returns the full response. */
function streamingModel(responses: ModelResponse[]): LanguageModel {
  let step = 0
  return {
    id: 'streaming-test',
    // Non-streaming fallback should never be hit when generateStream exists.
    generate: () => Promise.resolve({ content: 'FALLBACK' }),
    async *generateStream() {
      const response = responses[step++] ?? { content: '' }
      for (const word of response.content.split(' ').filter(Boolean)) {
        yield { delta: `${word} ` }
      }
      return response
    },
  }
}

describe('Token streaming', () => {
  it('emits token events for each delta and returns the assembled response', async () => {
    const model = streamingModel([{ content: 'hello there world' }])
    const tokens: string[] = []
    const result = await new Agent({
      model,
      hooks: { onEvent: (e: AgentEvent) => void (e.type === 'token' && tokens.push(e.delta)) },
    }).run('hi')

    expect(tokens).toEqual(['hello ', 'there ', 'world '])
    // The generator's return value is the real final answer (not the fallback).
    expect(result.output).toBe('hello there world')
  })

  it('still drives tool calls when streaming (final response carries toolCalls)', async () => {
    const model: LanguageModel = {
      id: 'stream-tools',
      generate: () => Promise.resolve({ content: '' }),
      async *generateStream(options) {
        // First model turn requests a tool; second streams the answer.
        const hasToolResult = options.messages.some((m) => m.role === 'tool')
        if (!hasToolResult) {
          return { content: '', toolCalls: [{ id: 't', name: 'ping', arguments: {} }] }
        }
        yield { delta: 'done' }
        return { content: 'done' }
      },
    }
    const { defineTool } = await import('@/index')
    const ping = defineTool({ name: 'ping', description: 'ping', execute: () => 'pong' })

    const result = await new Agent({ model, tools: [ping] }).run('go')
    expect(result.output).toBe('done')
    expect(result.toolsInvoked).toEqual(['ping'])
  })

  it('falls back to generate() when the model does not stream', async () => {
    const model: LanguageModel = {
      id: 'no-stream',
      generate: () => Promise.resolve({ content: 'plain answer' }),
    }
    const tokens: string[] = []
    const result = await new Agent({
      model,
      hooks: { onEvent: (e: AgentEvent) => void (e.type === 'token' && tokens.push(e.delta)) },
    }).run('hi')

    expect(result.output).toBe('plain answer')
    expect(tokens).toEqual([]) // no token events without streaming
  })
})
