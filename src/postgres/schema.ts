/**
 * DDL for the PostgreSQL backends. `pg` is a type-only import (no runtime
 * dependency) — pass a connected `Pool` in.
 */
import type { Pool } from 'pg'

/** Idempotent `CREATE TABLE IF NOT EXISTS` statements for all four ports. */
export const POSTGRES_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS momo_messages (
    id         BIGSERIAL PRIMARY KEY,
    namespace  TEXT        NOT NULL,
    message    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_momo_messages_ns_id ON momo_messages (namespace, id)',
  `CREATE TABLE IF NOT EXISTS momo_facts (
    namespace TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  )`,
  `CREATE TABLE IF NOT EXISTS momo_run_checkpoints (
    run_id     TEXT PRIMARY KEY,
    checkpoint JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS momo_llm_cache (
    cache_key  TEXT PRIMARY KEY,
    response   JSONB       NOT NULL,
    expires_at TIMESTAMPTZ
  )`,
]

/** Create the momo-agentic tables/indexes if they don't exist (run once at boot). */
export async function ensureSchema(pool: Pool): Promise<void> {
  for (const statement of POSTGRES_DDL) await pool.query(statement)
}
