/**
 * Layer 8 — Governance (offline evaluation).
 *
 * Where {@link AgentHooks} observe a single live run, evaluation observes
 * *quality across a dataset*: run an agent over a set of cases, score each
 * answer, and aggregate into a pass rate — the regression test for an agent's
 * behavior, not just its code. Pair it with a deterministic model (e.g. the
 * `ScriptedModel` test helper, or a recorded transcript) to replay fixed
 * responses, or with a real provider to measure live quality.
 *
 * Scorers are injected functions, so a check can be anything: an exact/substring
 * match, a regex, "did it call the right tool", or an LLM-as-judge. A few common
 * ones ship here; write your own as a plain {@link Scorer}.
 */
import type { IAgent, RunOptions, RunResult } from '@/agent/types'
import type { RunInput, Usage } from '@/shared/types'

/** One evaluation case: an input, an optional `expected` answer, and free metadata. */
export interface EvalCase {
  /** Label for reporting; defaults to the case index. */
  name?: string
  input: RunInput
  /** Reference answer, consumed by scorers like {@link exactMatch}. */
  expected?: string
  metadata?: Record<string, unknown>
}

/** What a {@link Scorer} receives: the case and the agent's result for it. */
export interface EvalSample {
  case: EvalCase
  result: RunResult
}

/** One scorer's verdict on a sample. */
export interface Score {
  /** Scorer name (becomes a column in the aggregated report). */
  name: string
  /** Normalized score in `[0, 1]`. */
  score: number
  passed: boolean
  /** Optional human-readable explanation (usually only on failure). */
  detail?: string
}

/** A check applied to each sample. Sync or async. */
export type Scorer = (sample: EvalSample) => Score | Promise<Score>

/** Options for {@link evaluate}. */
export interface EvaluateOptions {
  /** The checks to apply to every case. */
  scorers: Scorer[]
  /** Max cases run concurrently. Defaults to 1 (sequential). */
  concurrency?: number
  /** Run options forwarded to every `agent.run` call. */
  runOptions?: RunOptions
}

/** Per-case outcome in an {@link EvalReport}. */
export interface CaseResult {
  case: EvalCase
  output: string
  usage: Usage
  scores: Score[]
  /** True when every scorer passed. */
  passed: boolean
}

/** Aggregated result of an {@link evaluate} run. */
export interface EvalReport {
  cases: CaseResult[]
  total: number
  passed: number
  /** `passed / total` (0 when empty). */
  passRate: number
  /** Mean score per scorer name across all cases. */
  meanScores: Record<string, number>
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

/**
 * Run `agent` over `dataset`, score each answer, and aggregate into a report.
 *
 * @example
 * ```ts
 * const report = await evaluate(agent, [
 *   { input: 'capital of France?', expected: 'Paris' },
 *   { input: 'what time is it in Tokyo?' },
 * ], { scorers: [includesText('Paris'), usedTool('get_time')] })
 *
 * console.log(report.passRate, report.meanScores)
 * ```
 */
export async function evaluate(
  agent: IAgent,
  dataset: EvalCase[],
  options: EvaluateOptions,
): Promise<EvalReport> {
  const concurrency = Math.max(1, options.concurrency ?? 1)

  const cases = await mapPool(dataset, concurrency, async (evalCase) => {
    const result = await agent.run(evalCase.input, options.runOptions)
    const scores = await Promise.all(options.scorers.map((s) => s({ case: evalCase, result })))
    return {
      case: evalCase,
      output: result.output,
      usage: result.usage,
      scores,
      passed: scores.every((s) => s.passed),
    } satisfies CaseResult
  })

  const passed = cases.filter((c) => c.passed).length
  const totals = new Map<string, { sum: number; count: number }>()
  for (const c of cases) {
    for (const s of c.scores) {
      const t = totals.get(s.name) ?? { sum: 0, count: 0 }
      t.sum += s.score
      t.count++
      totals.set(s.name, t)
    }
  }
  const meanScores: Record<string, number> = {}
  for (const [name, { sum, count }] of totals) meanScores[name] = count ? sum / count : 0

  return {
    cases,
    total: dataset.length,
    passed,
    passRate: dataset.length ? passed / dataset.length : 0,
    meanScores,
  }
}

// --- Built-in scorers -------------------------------------------------------

/** Tuning for the built-in text scorers ({@link exactMatch}, {@link includesText}). */
export interface TextScorerOptions {
  /** Override the scorer's reported name. */
  name?: string
  /** Compare case-insensitively. */
  caseInsensitive?: boolean
  /** Trim whitespace before comparing. */
  trim?: boolean
}

const prep = (text: string, options: TextScorerOptions): string => {
  let value = options.trim ? text.trim() : text
  if (options.caseInsensitive) value = value.toLowerCase()
  return value
}

const verdict = (name: string, passed: boolean, detail?: string): Score => ({
  name,
  score: passed ? 1 : 0,
  passed,
  detail: passed ? undefined : detail,
})

/** Pass when the output equals the case's `expected` answer. */
export function exactMatch(options: TextScorerOptions = {}): Scorer {
  const name = options.name ?? 'exact_match'
  return ({ case: c, result }) => {
    const expected = c.expected ?? ''
    const passed = prep(result.output, options) === prep(expected, options)
    return verdict(name, passed, `expected "${expected}"`)
  }
}

/** Pass when the output contains `text`. */
export function includesText(text: string, options: TextScorerOptions = {}): Scorer {
  const name = options.name ?? 'includes'
  return ({ result }) => {
    const passed = prep(result.output, options).includes(prep(text, options))
    return verdict(name, passed, `missing "${text}"`)
  }
}

/** Pass when the output matches `pattern` (the regex is cloned per call). */
export function matchesRegex(pattern: RegExp, options: { name?: string } = {}): Scorer {
  const name = options.name ?? 'matches_regex'
  return ({ result }) =>
    verdict(
      name,
      new RegExp(pattern.source, pattern.flags).test(result.output),
      `no match ${pattern}`,
    )
}

/** Pass when the run invoked the tool named `tool`. */
export function usedTool(tool: string, options: { name?: string } = {}): Scorer {
  const name = options.name ?? `used_tool:${tool}`
  return ({ result }) => verdict(name, result.toolsInvoked.includes(tool), `did not call "${tool}"`)
}
