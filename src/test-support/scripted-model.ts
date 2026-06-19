import type { GenerateOptions, LanguageModel, ModelResponse } from '@/cognition/model'

/**
 * A deterministic {@link LanguageModel} for tests. It replays a fixed list of
 * responses; once exhausted it returns empty text. `calls` records every
 * request so tests can assert on what the agent sent (e.g. tool narrowing).
 */
export class ScriptedModel implements LanguageModel {
  readonly id = 'scripted-test-model'
  readonly calls: GenerateOptions[] = []
  private step = 0

  constructor(private readonly responses: ModelResponse[]) {}

  generate(options: GenerateOptions): Promise<ModelResponse> {
    this.calls.push(options)
    const response = this.responses[this.step] ?? { content: '' }
    this.step++
    return Promise.resolve(response)
  }
}
