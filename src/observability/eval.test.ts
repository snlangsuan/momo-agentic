import { describe, expect, it } from 'bun:test'
import { Agent, defineTool } from '../index'
import { ScriptedModel } from '../test-support/scripted-model'
import { evaluate, exactMatch, includesText, matchesRegex, usedTool } from './eval'

const fixedAnswers = (answers: string[]) =>
  new Agent({ model: new ScriptedModel(answers.map((content) => ({ content }))) })

describe('evaluate', () => {
  it('scores every case and aggregates pass rate + mean scores', async () => {
    const agent = fixedAnswers(['The capital is Paris.', 'I am not sure.'])
    const report = await evaluate(
      agent,
      [
        { input: 'capital of France?', expected: 'Paris' },
        { input: 'capital of Atlantis?', expected: 'Paris' },
      ],
      { scorers: [includesText('Paris')] },
    )

    expect(report.total).toBe(2)
    expect(report.passed).toBe(1)
    expect(report.passRate).toBe(0.5)
    expect(report.meanScores.includes).toBe(0.5)
    expect(report.cases[0]?.passed).toBe(true)
    expect(report.cases[1]?.passed).toBe(false)
  })

  it('a case passes only when every scorer passes', async () => {
    const agent = fixedAnswers(['Paris'])
    const report = await evaluate(agent, [{ input: 'q', expected: 'Paris' }], {
      scorers: [exactMatch(), includesText('London')],
    })
    expect(report.cases[0]?.passed).toBe(false)
    expect(report.passed).toBe(0)
  })

  it('preserves dataset order under concurrency', async () => {
    const agent = fixedAnswers(['a', 'b', 'c', 'd'])
    const report = await evaluate(
      agent,
      [
        { input: '1', expected: 'a' },
        { input: '2', expected: 'b' },
        { input: '3', expected: 'c' },
        { input: '4', expected: 'd' },
      ],
      { scorers: [exactMatch()], concurrency: 3 },
    )
    expect(report.cases.map((c) => c.output)).toEqual(['a', 'b', 'c', 'd'])
    expect(report.passRate).toBe(1)
  })

  it('supports a custom async scorer', async () => {
    const agent = fixedAnswers(['hello world'])
    const lengthScorer = async ({ result }: { result: { output: string } }) => ({
      name: 'long_enough',
      score: result.output.length >= 5 ? 1 : 0,
      passed: result.output.length >= 5,
    })
    const report = await evaluate(agent, [{ input: 'x' }], { scorers: [lengthScorer] })
    expect(report.meanScores.long_enough).toBe(1)
  })

  it('handles an empty dataset', async () => {
    const report = await evaluate(fixedAnswers([]), [], { scorers: [exactMatch()] })
    expect(report).toMatchObject({ total: 0, passed: 0, passRate: 0 })
  })
})

describe('built-in scorers', () => {
  it('exactMatch respects trim + caseInsensitive', async () => {
    const agent = fixedAnswers(['  PARIS  '])
    const report = await evaluate(agent, [{ input: 'q', expected: 'paris' }], {
      scorers: [exactMatch({ trim: true, caseInsensitive: true })],
    })
    expect(report.passRate).toBe(1)
  })

  it('matchesRegex tests the output', async () => {
    const agent = fixedAnswers(['order #12345 confirmed'])
    const report = await evaluate(agent, [{ input: 'q' }], {
      scorers: [matchesRegex(/#\d{5}/)],
    })
    expect(report.passRate).toBe(1)
  })

  it('usedTool checks the invoked tools', async () => {
    const getTime = defineTool({
      name: 'get_time',
      description: 't',
      execute: () => '09:00',
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: '1', name: 'get_time', arguments: {} }] },
      { content: 'It is 09:00.' },
    ])
    const agent = new Agent({ model, tools: [getTime] })

    const report = await evaluate(agent, [{ input: 'time?' }], { scorers: [usedTool('get_time')] })
    expect(report.passRate).toBe(1)
    expect(report.cases[0]?.scores[0]?.name).toBe('used_tool:get_time')
  })
})
