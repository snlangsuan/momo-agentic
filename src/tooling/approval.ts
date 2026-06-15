/**
 * Layer 4 — Tooling (human-in-the-loop approval).
 *
 * Some tools have real-world side effects — sending an email, moving money,
 * deleting data — that warrant a gate before they run. Mark such a tool with
 * `requiresApproval: true` and inject a {@link ToolApprover}: before the tool
 * executes, the approver is consulted and may allow it, deny it (the model
 * receives an error instead of a result), or allow it with edited arguments.
 *
 * The approver is just a port, so the decision can come from anywhere: an
 * auto-policy, a queue a human dequeues, a Slack approval button, a CLI prompt.
 */

/** What an approver is asked to rule on before a guarded tool runs. */
export interface ToolApprovalRequest {
  /** Name of the agent making the call. */
  agentName: string
  /** Name of the tool awaiting approval. */
  tool: string
  /** The arguments the model wants to call the tool with. */
  args: Record<string, unknown>
  /** Per-run data threaded through from {@link RunOptions.metadata}. */
  metadata: Record<string, unknown>
  /** Abort signal propagated from the agent run. */
  signal?: AbortSignal
}

/**
 * An approver's ruling: run as-is (`allow`), refuse (`deny`, optionally with a
 * reason fed back to the model), or run with substituted arguments (`edit`).
 */
export type ToolApprovalDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason?: string }
  | { decision: 'edit'; args: Record<string, unknown> }

/** Injected gate consulted before any tool flagged `requiresApproval` executes. */
export interface ToolApprover {
  readonly name: string
  approve(request: ToolApprovalRequest): Promise<ToolApprovalDecision> | ToolApprovalDecision
}
