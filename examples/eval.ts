/**
 * Evaluation harness (Layer 8 — Governance).
 *
 * Run an agent over a dataset and score the answers — a regression test for the
 * agent's *behavior*, not just its code. Scorers are plain functions applied to
 * EVERY case, so a check can be a substring/regex match, a per-case comparison
 * against `expected`, "did it call the right tool", or an LLM-as-judge. Here a
 * deterministic mock model makes the example reproducible with no API key.
 *
 * Run with:  bun run examples/eval.ts
 */
import { Agent, type Scorer, evaluate, matchesRegex } from '../src/index'
import { fnModel } from './_support/mock-model'

// Model under test: a tiny "capitals" knowledge base (deterministic).
const CAPITALS: Record<string, string> = { france: 'Paris', japan: 'Tokyo', italy: 'Rome' }
const agent = new Agent({
  model: fnModel('capitals', (opts) => {
    const q = (opts.messages.at(-1)?.content ?? '').toLowerCase()
    const hit = Object.entries(CAPITALS).find(([country]) => q.includes(country))
    return { content: hit ? `The capital is ${hit[1]}.` : "I don't know." }
  }),
})

// A custom scorer: does the answer contain this case's `expected` value?
const containsExpected: Scorer = ({ case: c, result }) => {
  const passed = !!c.expected && result.output.includes(c.expected)
  return {
    name: 'contains_expected',
    score: passed ? 1 : 0,
    passed,
    detail: `expected "${c.expected}"`,
  }
}

const report = await evaluate(
  agent,
  [
    { name: 'france', input: 'capital of France?', expected: 'Paris' },
    { name: 'japan', input: 'capital of Japan?', expected: 'Tokyo' },
    { name: 'atlantis', input: 'capital of Atlantis?', expected: 'Atlantis City' }, // will fail
  ],
  {
    // built-in `matchesRegex` (answered something concrete) + the custom scorer above
    scorers: [matchesRegex(/capital is \w+/i, { name: 'gave_answer' }), containsExpected],
    concurrency: 3,
  },
)

console.log(
  `✅ pass rate: ${(report.passRate * 100).toFixed(0)}% (${report.passed}/${report.total})`,
)
console.log('📊 mean scores:', report.meanScores)
for (const c of report.cases) {
  const marks = c.scores.map((s) => `${s.name}=${s.passed ? '✓' : '✗'}`).join('  ')
  console.log(`  • ${c.case.name}: ${c.passed ? 'PASS' : 'FAIL'}  [${marks}]`)
}
