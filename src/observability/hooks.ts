/**
 * Layer 7 (Application) + Layer 8 (Governance) — observability hooks.
 *
 * A single event stream serves both layers: the host app consumes events to
 * drive a UI (streaming "thinking", tool activity, final answer), while
 * governance consumes the same stream for monitoring, usage metering, and
 * audit. Everything is push-based via {@link AgentHooks.onEvent} so the library
 * never imports a transport (SSE, WebSocket, logger) itself.
 */
import type { Message, Usage } from '../shared/types'

/** A discriminated union of everything that happens during a run. */
export type AgentEvent =
  | { type: 'run_start'; agent: string; input: string }
  | { type: 'plan'; agent: string; mode: string; tools?: string[]; reason?: string }
  | { type: 'thinking'; agent: string; text: string }
  | { type: 'tool_call'; agent: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; agent: string; tool: string; result: unknown }
  | { type: 'message'; agent: string; message: Message }
  | { type: 'usage'; agent: string; usage: Usage; tools: string[]; skills: string[] }
  | { type: 'error'; agent: string; stage: string; error: Error }
  | { type: 'run_end'; agent: string; output: string; usage: Usage }

/** The hook port. Implement `onEvent` to receive the run's event stream. */
export interface AgentHooks {
  onEvent?(event: AgentEvent): void | Promise<void>
}

/**
 * Compose several hook listeners into one. Listeners run in order; a throwing
 * listener is isolated so it cannot break the run or the other listeners.
 */
export function combineHooks(...hooks: Array<AgentHooks | undefined>): AgentHooks {
  const active = hooks.filter((h): h is AgentHooks => !!h?.onEvent)
  return {
    async onEvent(event) {
      for (const hook of active) {
        try {
          await hook.onEvent?.(event)
        } catch {
          // A listener must never break the run or sibling listeners.
        }
      }
    },
  }
}

/** Aggregated counters produced by {@link UsageTracker}. */
export interface UsageSnapshot {
  runs: number
  usage: Usage
  toolCalls: number
}

/**
 * A ready-made governance hook that tallies token usage and tool calls across
 * runs. Pass `tracker.hooks` to an agent, then read `tracker.snapshot()`.
 */
export class UsageTracker {
  private runs = 0
  private toolCalls = 0
  private readonly total: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  readonly hooks: AgentHooks = {
    onEvent: (event) => {
      if (event.type === 'tool_call') this.toolCalls++
      if (event.type === 'run_end') {
        this.runs++
        this.total.inputTokens += event.usage.inputTokens
        this.total.outputTokens += event.usage.outputTokens
        this.total.totalTokens += event.usage.totalTokens
      }
    },
  }

  snapshot(): UsageSnapshot {
    return { runs: this.runs, usage: { ...this.total }, toolCalls: this.toolCalls }
  }
}
