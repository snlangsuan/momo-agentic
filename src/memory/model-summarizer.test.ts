import { describe, expect, it } from 'bun:test'
import { InMemoryMemory } from '@/memory/in-memory'
import { createModelSummarizer } from '@/memory/model-summarizer'
import { SummarizingMemory } from '@/memory/summarizing-memory'
import type { Message } from '@/shared/types'
import { ScriptedModel } from '@/test-support/scripted-model'

const messages: Message[] = [
  { role: 'user', content: 'My name is Somchai and I like cycling.' },
  { role: 'assistant', content: 'Nice to meet you, Somchai!' },
]

describe('createModelSummarizer', () => {
  it('returns the model output, trimmed', async () => {
    const model = new ScriptedModel([{ content: '  Somchai likes cycling.  ' }])
    const summarizer = createModelSummarizer(model)
    const summary = await summarizer.summarize(messages)
    expect(summary).toBe('Somchai likes cycling.')
  })

  it('sends a system instruction and the rendered transcript, no tools', async () => {
    const model = new ScriptedModel([{ content: 'ok' }])
    await createModelSummarizer(model).summarize(messages)

    const sent = model.calls[0]
    expect(sent?.tools).toEqual([])
    expect(sent?.messages[0]?.role).toBe('system')
    expect(sent?.messages[1]?.content).toContain('user: My name is Somchai')
    expect(sent?.messages[1]?.content).toContain('assistant: Nice to meet you')
  })

  it('folds a previous summary into the prompt and honours maxWords', async () => {
    const model = new ScriptedModel([{ content: 'updated' }])
    await createModelSummarizer(model, { maxWords: 50 }).summarize(messages, 'older summary')

    const prompt = model.calls[0]?.messages[1]?.content ?? ''
    expect(prompt).toContain('older summary')
    expect(prompt).toContain('at most 50 words')
  })

  it('drives SummarizingMemory end to end', async () => {
    const model = new ScriptedModel([{ content: 'compressed history' }])
    const inner = new InMemoryMemory()
    for (let i = 0; i < 6; i++) inner.appendMessage({ role: 'user', content: `m${i}` })

    const memory = new SummarizingMemory(inner, {
      summarizer: createModelSummarizer(model),
      threshold: 4,
      keepRecent: 2,
    })
    const history = await memory.loadHistory()
    expect(history[0]?.content).toContain('compressed history')
    expect(history).toHaveLength(3) // summary + 2 recent
  })
})
