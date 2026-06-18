/**
 * Layer 6 — Memory (summarization helper).
 *
 * Build a {@link Summarizer} from any {@link LanguageModel}, so wiring up a
 * {@link SummarizingMemory} no longer requires hand-writing a summarize loop.
 * Stays provider-agnostic: it only talks to the injected model port and uses no
 * tools, so it composes with whatever adapter the user already supplies.
 */
import type { LanguageModel } from '../cognition/model'
import type { Message } from '../shared/types'
import type { Summarizer } from './summarizing-memory'

/** Options for {@link createModelSummarizer}. */
export interface ModelSummarizerOptions {
  /**
   * System instruction steering the summary. Defaults to a neutral prompt that
   * preserves facts, decisions, names, and open questions.
   */
  instruction?: string
  /** Soft cap on summary length, surfaced to the model as a word budget. Defaults to 200. */
  maxWords?: number
}

const DEFAULT_INSTRUCTION =
  'You compress a conversation transcript into a concise summary for an AI assistant to ' +
  'carry as context. Preserve durable facts, decisions, user preferences, named entities, ' +
  'and unresolved questions. Drop pleasantries and redundancy. Write plain prose, no preamble.'

/** Render a transcript into a plain-text block the model can summarize. */
function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      const label = m.name ? `${m.role}(${m.name})` : m.role
      return `${label}: ${m.content}`.trim()
    })
    .join('\n')
}

/**
 * Build a {@link Summarizer} that delegates compression to `model`. Pass it to
 * {@link SummarizingMemory} to keep short-term context bounded automatically.
 *
 * @example
 * ```ts
 * const summarizer = createModelSummarizer(model)
 * const memory = new SummarizingMemory(new InMemoryMemory(), { summarizer })
 * ```
 */
export function createModelSummarizer(
  model: LanguageModel,
  options: ModelSummarizerOptions = {},
): Summarizer {
  const instruction = options.instruction ?? DEFAULT_INSTRUCTION
  const maxWords = options.maxWords ?? 200

  return {
    async summarize(messages: Message[], previousSummary?: string): Promise<string> {
      const transcript = renderTranscript(messages)
      const prior = previousSummary
        ? `Summary so far (extend, do not repeat it verbatim):\n${previousSummary}\n\n`
        : ''
      const prompt =
        `${prior}New transcript to fold into the summary:\n${transcript}\n\n` +
        `Write the updated summary in at most ${maxWords} words.`

      const response = await model.generate({
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: prompt },
        ],
        tools: [],
      })
      return response.content.trim()
    },
  }
}
