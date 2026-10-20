import {
  type SqlSchemaOptions,
  type SqlSchemaReport,
  explainCreateError,
  explainQueryError,
  probeTables,
  resolveTables,
  selectedParts,
  tablesFor,
} from '@/shared/sql-schema'
/**
 * DDL for the MySQL / MariaDB backends. `mysql2` is a type-only import (no
 * runtime dependency) — pass a connected `Pool` (`mysql2/promise`) in.
 *
 * Works on MySQL 5.7+ (native `JSON`) and MariaDB 10.2+ (`JSON` = `LONGTEXT`
 * alias); the backends transparently handle MariaDB returning JSON as a string.
 *
 * Creating the tables is up to you: call {@link ensureSchema} at boot if the DB
 * user may CREATE TABLE, or apply {@link mysqlDdl} through your own migrations /
 * a DBA and verify with {@link checkSchema}. The backends never create tables on
 * their own.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise'

/**
 * The idempotent `CREATE TABLE IF NOT EXISTS` statements for the selected table
 * groups and names — hand them to a migration tool or a DBA when the app's DB
 * user can't create tables.
 *
 * ```ts
 * console.log(mysqlDdl({ include: ['memory'] }).join(';\n\n') + ';')
 * ```
 */
export function mysqlDdl(options: SqlSchemaOptions = {}): string[] {
  const t = resolveTables(options.tables)
  const ddl: string[] = []
  for (const part of selectedParts(options.include)) {
    if (part === 'memory') {
      ddl.push(
        `CREATE TABLE IF NOT EXISTS ${t.messages} (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    namespace  VARCHAR(255) NOT NULL,
    message    JSON         NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_momo_messages_ns_id (namespace, id)
  )`,
        `CREATE TABLE IF NOT EXISTS ${t.facts} (
    namespace VARCHAR(255) NOT NULL,
    \`key\`     VARCHAR(255) NOT NULL,
    value     TEXT         NOT NULL,
    PRIMARY KEY (namespace, \`key\`)
  )`,
      )
    } else if (part === 'runStore') {
      ddl.push(`CREATE TABLE IF NOT EXISTS ${t.runCheckpoints} (
    run_id     VARCHAR(255) PRIMARY KEY,
    checkpoint JSON      NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)
    } else {
      ddl.push(`CREATE TABLE IF NOT EXISTS ${t.llmCache} (
    cache_key  VARCHAR(255) PRIMARY KEY,
    response   JSON      NOT NULL,
    expires_at TIMESTAMP NULL
  )`)
    }
  }
  return ddl
}

/** Every default `momo_*` table statement (same as `mysqlDdl()`). */
export const MYSQL_DDL: readonly string[] = mysqlDdl()

/**
 * Opt-in: create the momo-agentic tables if they don't exist (run once at boot).
 * Needs CREATE privilege — if the DB user lacks it this throws a `SqlSchemaError`
 * explaining the manual route ({@link mysqlDdl} + {@link checkSchema}).
 *
 * ```ts
 * await ensureSchema(pool)                          // all tables
 * await ensureSchema(pool, { include: ['memory'] }) // only what you use
 * ```
 */
export async function ensureSchema(pool: Pool, options: SqlSchemaOptions = {}): Promise<void> {
  for (const statement of mysqlDdl(options)) {
    try {
      await pool.query(statement)
    } catch (err) {
      const table = statement.match(/ EXISTS (\S+) \(/)?.[1] ?? ''
      throw explainCreateError(err, table, 'mysql')
    }
  }
}

/**
 * Read-only check that the tables exist and are readable — never creates anything.
 * Use it at boot instead of {@link ensureSchema} when tables are managed by
 * migrations / a DBA, to fail fast with a clear list rather than on the first turn.
 */
export function checkSchema(pool: Pool, options: SqlSchemaOptions = {}): Promise<SqlSchemaReport> {
  return probeTables(tablesFor(options), (sql) => pool.query(sql))
}

/** Run a query against `table`, turning missing-table/privilege errors into a `SqlSchemaError`. */
export async function myQuery(
  pool: Pool,
  table: string,
  sql: string,
  params?: unknown[],
): Promise<RowDataPacket[]> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    return rows
  } catch (err) {
    throw explainQueryError(err, table, 'mysql')
  }
}

/** MySQL returns JSON columns parsed; MariaDB returns strings — normalize both. */
export const asJson = <T>(value: unknown): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : (value as T)
