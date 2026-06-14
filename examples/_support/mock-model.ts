/**
 * Tiny mock LanguageModels for the runnable examples — so each example can focus
 * on the feature it demonstrates instead of a real provider. Swap any of these
 * for a real `LanguageModel` adapter (see examples/ai-assistant/gemini-model.ts).
 */
import type { GenerateOptions, LanguageModel, ModelResponse } from '../../src/index'

/** Replays a fixed list of responses, then returns empty text. */
export function scriptModel(responses: ModelResponse[]): LanguageModel {
  let step = 0
  return {
    id: 'mock:script',
    generate: () => Promise.resolve(responses[step++] ?? { content: '' }),
  }
}

/** Computes each response from the request (e.g. to branch on the tools offered). */
export function fnModel(
  id: string,
  fn: (options: GenerateOptions, step: number) => ModelResponse,
): LanguageModel {
  let step = 0
  return { id, generate: (options) => Promise.resolve(fn(options, step++)) }
}
