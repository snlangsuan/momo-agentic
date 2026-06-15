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
import type { Message } from '../shared/types'

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
  const cost = (message: Message): number => counter.count(message.content)

  let total = messages.reduce((sum, message) => sum + cost(message), 0)
  if (total <= limit) return messages

  const result = [...messages]
  let i = 0
  while (i < result.length && total > limit) {
    const message = result[i]
    const isLast = i === result.length - 1
    if (!message || message.role === 'system' || isLast) {
      i++
      continue
    }
    total -= cost(message)
    result.splice(i, 1) // removed — re-check the element now at i
  }
  return result
}
