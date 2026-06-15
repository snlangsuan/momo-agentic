/**
 * Layer 8 — Governance (output guardrails).
 *
 * A complement to the in-prompt `guardrails` text: where that *asks* the model to
 * behave, an {@link OutputGuardrail} *enforces* it. After the reasoning strategy
 * produces an answer — but before it is persisted or returned — each configured
 * guardrail inspects the candidate output and may block it, substituting a safe
 * replacement (a refusal, a redacted version, a fallback). Guardrails are an
 * injected port, so the check can be anything: a banned-term scan, a regex, an
 * external moderation API, or a second model call.
 */

/** Context handed to an {@link OutputGuardrail} alongside the candidate output. */
export interface GuardrailContext {
  /** Name of the agent whose output is being checked. */
  agentName: string
  /** The user's input text for this turn (the prompt that produced the output). */
  input: string
  /** Abort signal propagated from the agent run. */
  signal?: AbortSignal
  /** Per-run data threaded through from {@link RunOptions.metadata} (userId, ...). */
  metadata: Record<string, unknown>
}

/**
 * The outcome of one guardrail check: either let the output through, or block it
 * and replace it. A blocked verdict without `output` falls back to a generic
 * refusal.
 */
export type GuardrailVerdict = { pass: true } | { pass: false; output?: string; reason?: string }

/**
 * An injected check on the user's input, run BEFORE the model. A `pass: false`
 * verdict short-circuits the turn: the model is never called, and the verdict's
 * `output` (or a default refusal) is returned as the answer. Use it to stop
 * prompt injection, jailbreaks, or disallowed/PII input early.
 */
export interface InputGuardrail {
  readonly name: string
  check(input: string, context: GuardrailContext): Promise<GuardrailVerdict> | GuardrailVerdict
}

/**
 * An injected output check. Runs after the answer is produced; returning a
 * `pass: false` verdict replaces the answer with the verdict's `output` (or a
 * default refusal) and stops the remaining guardrails.
 */
export interface OutputGuardrail {
  readonly name: string
  check(output: string, context: GuardrailContext): Promise<GuardrailVerdict> | GuardrailVerdict
}

/** Fallback answer when a guardrail blocks without supplying a replacement. */
export const DEFAULT_GUARDRAIL_REFUSAL = "I'm sorry, but I can't help with that."
