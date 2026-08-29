/**
 * Layer 5 — Cognition (context-window budgeting).
 *
 * A {@link TokenCounter} is an injected port that estimates how many tokens a
 * piece of text costs; {@link fitContext} uses it to trim a transcript so it fits
 * a model's context window. Trimming keeps all `system` messages and the most
 * recent turns, dropping the OLDEST middle messages first — never the current
 * (last) message. Plug a real provider tokenizer for precision, or use the
 * dependency-free {@link approxTokenCounter} (~4 chars/token) as a default.
 */
import type { Message } from '@/shared/types'

/** Estimates the token cost of a string. */
export interface TokenCounter {
  count(text: string): number
}

/** Zero-dependency heuristic counter: roughly 4 characters per token. */
export const approxTokenCounter: TokenCounter = {
  count: (text) => Math.ceil(text.length / 4),
}

/**
 * Return a copy of `messages` trimmed to fit `limit` tokens. All `system`
 * messages and the final message are always kept; the oldest of the rest are
 * dropped until the transcript fits (or only protected messages remain).
 */
export function fitContext(
  messages: Message[],
  options: { counter: TokenCounter; limit: number },
): Message[] {
  const { counter, limit } = options
  // Count each message ONCE up front, then mark drops and build the result in a
  // single pass: repeatedly re-counting and splicing out of the array is O(n²)
  // on a long transcript, and this trims on every turn.
  const costs = messages.map((message) => counter.count(message.content))
  let total = 0
  for (const cost of costs) total += cost
  if (total <= limit) return messages

  const last = messages.length - 1
  const drop = new Array<boolean>(messages.length).fill(false)
  for (let i = 0; i < last && total > limit; i++) {
    const message = messages[i]
    if (!message || message.role === 'system') continue // protected, as is the last message
    total -= costs[i] ?? 0
    drop[i] = true
  }
  return messages.filter((_, i) => !drop[i])
}
