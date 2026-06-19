import type { RunCheckpoint, RunStore } from '@/agent/run-store'
import { asJson } from '@/mysql/schema'
/**
 * Layer 8 — a MySQL / MariaDB-backed {@link RunStore} for durable runs (via `mysql2`).
 *
 * Persists checkpoints in `momo_run_checkpoints` for cross-process resume.
 * `mysql2` is a type-only import.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise'

/** A MySQL / MariaDB-backed {@link RunStore}. Run {@link ensureSchema} once to create the table. */
export class MySqlRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT checkpoint FROM momo_run_checkpoints WHERE run_id=?',
      [runId],
    )
    return rows[0] ? asJson<RunCheckpoint>(rows[0].checkpoint) : undefined
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO momo_run_checkpoints (run_id, checkpoint) VALUES (?, ?) ON DUPLICATE KEY UPDATE checkpoint = VALUES(checkpoint)',
      [checkpoint.runId, JSON.stringify(checkpoint)],
    )
  }

  async delete(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM momo_run_checkpoints WHERE run_id=?', [runId])
  }
}
