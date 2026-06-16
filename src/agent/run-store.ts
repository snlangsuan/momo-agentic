/**
 * Durable runs (Layer 8 — Governance / reliability).
 *
 * A long agentic turn can span many model calls and tool steps; if the process
 * dies mid-loop, the work is normally lost. A {@link RunStore} persists a
 * {@link RunCheckpoint} after every completed step, so a later run can RESUME
 * from the last checkpoint instead of starting over.
 *
 * The store is an injected port — an in-process map (shipped here) or a shared
 * Redis/Postgres the host wraps. Resume is **at-least-once**: a tool that
 * finished before the crash is already in the saved transcript and is not
 * re-run, but a tool that was in flight when the crash hit will run again on
 * resume — so durable tools should be idempotent.
 */
import type { Message, Usage } from '../shared/types'

/** A point-in-time snapshot of an in-flight run. */
export interface RunCheckpoint {
  /** Caller-supplied id correlating a run with its checkpoint. */
  runId: string
  /** The original user input text for the run (for reference / observability). */
  input: string
  /** The working transcript so far (system + history + assistant/tool steps). */
  messages: Message[]
  /** Number of completed reasoning steps. */
  step: number
  /** Tools invoked so far, in call order. */
  toolsInvoked: string[]
  /** Cumulative token usage so far. */
  usage: Usage
  /** `running` while in flight; a finished run deletes its checkpoint. */
  status: 'running' | 'done'
}

/** Persistence port for {@link RunCheckpoint}s. Implement to back it with anything. */
export interface RunStore {
  load(runId: string): Promise<RunCheckpoint | undefined> | RunCheckpoint | undefined
  save(checkpoint: RunCheckpoint): Promise<void> | void
  delete(runId: string): Promise<void> | void
}

/**
 * A single-process {@link RunStore} backed by a Map. Checkpoints are deep-copied
 * in and out so the live transcript can't mutate a saved snapshot. Swap in a
 * shared store to survive a process restart across instances.
 */
export class InMemoryRunStore implements RunStore {
  private readonly store = new Map<string, RunCheckpoint>()

  load(runId: string): RunCheckpoint | undefined {
    const found = this.store.get(runId)
    return found ? structuredClone(found) : undefined
  }

  save(checkpoint: RunCheckpoint): void {
    this.store.set(checkpoint.runId, structuredClone(checkpoint))
  }

  delete(runId: string): void {
    this.store.delete(runId)
  }
}
