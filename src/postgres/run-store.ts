import type { RunCheckpoint, RunStore } from '@/agent/run-store'
import { pgQuery } from '@/postgres/schema'
import { type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
/**
 * Layer 8 — a PostgreSQL-backed {@link RunStore} for durable runs (via `pg`).
 *
 * Persists checkpoints in `momo_run_checkpoints` (rename via `tables`) so a run
 * can resume on a different process/instance after a crash. `pg` is a type-only
 * import.
 */
import type { Pool } from 'pg'

/**
 * A PostgreSQL-backed {@link RunStore}. The table must already exist — create it
 * with `ensureSchema(pool, { include: ['runStore'] })` or apply `postgresDdl()`.
 */
export class PostgresRunStore implements RunStore {
  private readonly table: string

  constructor(
    private readonly pool: Pool,
    options: SqlTableOptions = {},
  ) {
    this.table = resolveTables(options.tables).runCheckpoints
  }

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const { rows } = await pgQuery(
      this.pool,
      this.table,
      `SELECT checkpoint FROM ${this.table} WHERE run_id=$1`,
      [runId],
    )
    return rows[0]?.checkpoint as RunCheckpoint | undefined
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    await pgQuery(
      this.pool,
      this.table,
      `INSERT INTO ${this.table} (run_id, checkpoint, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (run_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = now()`,
      [checkpoint.runId, JSON.stringify(checkpoint)],
    )
  }

  async delete(runId: string): Promise<void> {
    await pgQuery(this.pool, this.table, `DELETE FROM ${this.table} WHERE run_id=$1`, [runId])
  }
}
