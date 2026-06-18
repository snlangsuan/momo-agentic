/**
 * DDL for the MySQL / MariaDB backends. `mysql2` is a type-only import (no
 * runtime dependency) — pass a connected `Pool` (`mysql2/promise`) in.
 *
 * Works on MySQL 5.7+ (native `JSON`) and MariaDB 10.2+ (`JSON` = `LONGTEXT`
 * alias); the backends transparently handle MariaDB returning JSON as a string.
 */
import type { Pool } from 'mysql2/promise'

/** Idempotent `CREATE TABLE IF NOT EXISTS` statements for all four ports. */
export const MYSQL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS momo_messages (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    namespace  VARCHAR(255) NOT NULL,
    message    JSON         NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_momo_messages_ns_id (namespace, id)
  )`,
  `CREATE TABLE IF NOT EXISTS momo_facts (
    namespace VARCHAR(255) NOT NULL,
    \`key\`     VARCHAR(255) NOT NULL,
    value     TEXT         NOT NULL,
    PRIMARY KEY (namespace, \`key\`)
  )`,
  `CREATE TABLE IF NOT EXISTS momo_run_checkpoints (
    run_id     VARCHAR(255) PRIMARY KEY,
    checkpoint JSON      NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS momo_llm_cache (
    cache_key  VARCHAR(255) PRIMARY KEY,
    response   JSON      NOT NULL,
    expires_at TIMESTAMP NULL
  )`,
]

/** Create the momo-agentic tables/indexes if they don't exist (run once at boot). */
export async function ensureSchema(pool: Pool): Promise<void> {
  for (const statement of MYSQL_DDL) await pool.query(statement)
}

/** MySQL returns JSON columns parsed; MariaDB returns strings — normalize both. */
export const asJson = <T>(value: unknown): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : (value as T)
