/**
 * Layer 8 — a PostgreSQL-backed {@link RunStore} for durable runs (via `pg`).
 *
 * Persists checkpoints in `momo_run_checkpoints` so a run can resume on a
 * different process/instance after a crash. `pg` is a type-only import.
 */
import type { Pool } from 'pg'
import type { RunCheckpoint, RunStore } from '../agent/run-store'

/** A PostgreSQL-backed {@link RunStore}. Run {@link ensureSchema} once to create the table. */
export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const { rows } = await this.pool.query(
      'SELECT checkpoint FROM momo_run_checkpoints WHERE run_id=$1',
      [runId],
    )
    return rows[0]?.checkpoint as RunCheckpoint | undefined
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO momo_run_checkpoints (run_id, checkpoint, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (run_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = now()`,
      [checkpoint.runId, JSON.stringify(checkpoint)],
    )
  }

  async delete(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM momo_run_checkpoints WHERE run_id=$1', [runId])
  }
}
