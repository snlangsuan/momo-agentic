import type { RunCheckpoint, RunStore } from '@/agent/run-store'
import { asJson, myQuery } from '@/mysql/schema'
import { type SqlTableOptions, resolveTables } from '@/shared/sql-schema'
/**
 * Layer 8 — a MySQL / MariaDB-backed {@link RunStore} for durable runs (via `mysql2`).
 *
 * Persists checkpoints in `momo_run_checkpoints` (rename via `tables`) for
 * cross-process resume. `mysql2` is a type-only import.
 */
import type { Pool } from 'mysql2/promise'

/**
 * A MySQL / MariaDB-backed {@link RunStore}. The table must already exist — create
 * it with `ensureSchema(pool, { include: ['runStore'] })` or apply `mysqlDdl()`.
 */
export class MySqlRunStore implements RunStore {
  private readonly table: string

  constructor(
    private readonly pool: Pool,
    options: SqlTableOptions = {},
  ) {
    this.table = resolveTables(options.tables).runCheckpoints
  }

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const rows = await myQuery(
      this.pool,
      this.table,
      `SELECT checkpoint FROM ${this.table} WHERE run_id=?`,
      [runId],
    )
    return rows[0] ? asJson<RunCheckpoint>(rows[0].checkpoint) : undefined
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    await myQuery(
      this.pool,
      this.table,
      `INSERT INTO ${this.table} (run_id, checkpoint) VALUES (?, ?) ON DUPLICATE KEY UPDATE checkpoint = VALUES(checkpoint)`,
      [checkpoint.runId, JSON.stringify(checkpoint)],
    )
  }

  async delete(runId: string): Promise<void> {
    await myQuery(this.pool, this.table, `DELETE FROM ${this.table} WHERE run_id=?`, [runId])
  }
}
