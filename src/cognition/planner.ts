/**
 * Layer 5 — Cognition (planning / routing).
 *
 * A Planner decides, before the reasoning loop runs, how to approach a request:
 * answer directly, or narrow the toolset to a focused subset (the "direct tool"
 * fast-path). It is OPTIONAL — with no planner the agent exposes all tools and
 * lets the model decide. Implement one to add intent classification or routing.
 */
import type { Message } from '@/shared/types'

/** Outcome of planning for one user turn. */
export interface Plan {
  /**
   * - `respond`: answer directly, expose no tools this turn.
   * - `auto`: expose the full toolset; the model decides what to call.
   * - `use_tools`: expose only {@link Plan.tools} (focused fast-path).
   */
  mode: 'respond' | 'auto' | 'use_tools'
  /** Tool names to expose when `mode === 'use_tools'`. */
  tools?: string[]
  /** Optional free-form rationale, surfaced via hooks for observability. */
  reason?: string
}

/** Context handed to a planner. */
export interface PlanContext {
  agentName: string
  history: Message[]
  /** Names of all tools currently available to the agent. */
  availableTools: string[]
  signal?: AbortSignal
}

/** Optional planning/routing port. */
export interface Planner {
  readonly name: string
  plan(input: string, context: PlanContext): Promise<Plan> | Plan
}
