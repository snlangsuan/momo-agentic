/**
 * Layer 5 — Cognition (model invocation helper).
 *
 * A single entry point for strategies to call the model: when the adapter
 * implements {@link LanguageModel.generateStream}, token deltas are surfaced as
 * `token` events as they arrive; otherwise it falls back to the one-shot
 * {@link LanguageModel.generate}. Keeping this in one place means every strategy
 * gets streaming for free, without duplicating the stream-or-generate branch.
 */
import type { AgentHooks } from '../observability/hooks'
import type { GenerateOptions, LanguageModel, ModelResponse } from './model'

/** Call the model, emitting `token` events for each delta when streaming is supported. */
export async function runModel(
  model: LanguageModel,
  options: GenerateOptions,
  hooks: AgentHooks | undefined,
  agentName: string,
): Promise<ModelResponse> {
  if (!model.generateStream) return model.generate(options)

  const stream = model.generateStream(options)
  let next = await stream.next()
  while (!next.done) {
    if (next.value.delta) {
      await hooks?.onEvent?.({ type: 'token', agent: agentName, delta: next.value.delta })
    }
    next = await stream.next()
  }
  // The generator's RETURN value is the assembled final response.
  return next.value
}
