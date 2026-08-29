/**
 * Layer 5 — Cognition (deterministic canned replies).
 *
 * Not every turn needs a model. Greetings, menu keywords, `/help`, a fixed
 * disclaimer — for these the answer is known up front, and paying a provider
 * round-trip for it costs money, latency, and determinism. A pattern reply maps
 * an input to a fixed answer: when one matches, the agent returns it and the
 * model is never called.
 *
 * Matching is deliberately boring — an exact string or a `RegExp`, first match
 * in list order wins — so the routing stays inspectable. For anything that has
 * to *decide* (intent classification, tool narrowing), use a {@link Planner}
 * instead: that is the layer for judgment, this one is for lookups.
 */
/**
 * One canned answer and the input that triggers it.
 *
 * @example
 * ```ts
 * const replies: PatternReply[] = [
 *   { pattern: 'ping', reply: 'pong' },
 *   { pattern: /^\/help\b/i, reply: { type: 'card', title: 'Commands', items: ['/help'] } },
 * ]
 * ```
 */
export interface PatternReply {
  /**
   * What to match the input against. A string matches EXACTLY (compared to the
   * trimmed input, case-sensitive — use a `RegExp` for anything looser); a
   * `RegExp` is tested against the trimmed input. A `g`-flagged pattern is
   * matched from the start every time, so it never goes stale between turns.
   */
  pattern: string | RegExp
  /**
   * The answer to return. A string is the reply text; any other value is a
   * structured reply — it is preserved as-is on {@link RunResult.returns} and
   * emitted on the `output` event, with its JSON on {@link RunResult.output}.
   */
  reply: unknown
  /** Optional label for the `pattern_reply` event, for tracing which rule fired. */
  name?: string
}

/**
 * Find the first {@link PatternReply} matching `input`, or `undefined` when none
 * do. Order is significant: list the most specific patterns first.
 *
 * @example
 * ```ts
 * const hit = matchPatternReply('  ping ', [{ pattern: 'ping', reply: 'pong' }])
 * hit?.reply // 'pong'
 * ```
 */
export function matchPatternReply(
  input: string,
  replies: readonly PatternReply[],
): PatternReply | undefined {
  const text = input.trim()
  for (const entry of replies) {
    if (typeof entry.pattern === 'string') {
      if (entry.pattern === text) return entry
      continue
    }
    // A global/sticky RegExp carries `lastIndex` between `test` calls, which
    // would make the same input match only every other turn. Reset it first.
    entry.pattern.lastIndex = 0
    if (entry.pattern.test(text)) return entry
  }
  return undefined
}

/** The reply's text form: a string reply as-is, anything else as JSON. */
export function patternReplyText(reply: unknown): string {
  return typeof reply === 'string' ? reply : JSON.stringify(reply)
}

/** Human-readable form of a pattern, for the `pattern_reply` event. */
export function patternLabel(pattern: string | RegExp): string {
  return typeof pattern === 'string' ? pattern : pattern.toString()
}
