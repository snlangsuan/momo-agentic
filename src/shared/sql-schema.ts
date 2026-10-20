/**
 * Table naming, DDL selection, and schema-error translation shared by the SQL
 * backends (`momo-agentic/postgres`, `momo-agentic/mysql`). Driver-agnostic — no
 * `pg`/`mysql2` import here.
 */

/** Which group of tables a port needs: `memory` (messages + facts), `runStore`, `cache`. */
export type SqlSchemaPart = 'memory' | 'runStore' | 'cache'

/** Every {@link SqlSchemaPart}, in DDL order. */
export const SQL_SCHEMA_PARTS: readonly SqlSchemaPart[] = ['memory', 'runStore', 'cache']

/**
 * Table names for the SQL backends. Each defaults to its `momo_*` name; set one to
 * point a backend at a table you created/named yourself (e.g. `'app.bot_messages'`).
 * Names must be plain identifiers, optionally qualified with one schema/database
 * prefix — they are interpolated into SQL, so anything else is rejected.
 */
export interface SqlTableNames {
  /** Conversation messages. Defaults to `"momo_messages"`. */
  messages?: string
  /** Long-term facts. Defaults to `"momo_facts"`. */
  facts?: string
  /** Durable-run checkpoints. Defaults to `"momo_run_checkpoints"`. */
  runCheckpoints?: string
  /** LLM response cache. Defaults to `"momo_llm_cache"`. */
  llmCache?: string
}

/** Options shared by the SQL backend classes: which tables to read/write. */
export interface SqlTableOptions {
  /** Override table names (pass the same object to `ensureSchema`/`checkSchema`). */
  tables?: SqlTableNames
}

/** Options for the SQL `ensureSchema` / `checkSchema` / DDL helpers. */
export interface SqlSchemaOptions extends SqlTableOptions {
  /**
   * Only the table groups you actually use. Defaults to all of them — e.g. pass
   * `['memory']` if you never use the run store or the model cache.
   */
  include?: readonly SqlSchemaPart[]
}

/** Result of `checkSchema`: which tables are absent or unreadable for this DB user. */
export interface SqlSchemaReport {
  /** `true` when every checked table exists and is readable. */
  ok: boolean
  /** Tables that don't exist. */
  missing: string[]
  /** Tables that exist but this DB user may not read. */
  denied: string[]
}

/** Why a {@link SqlSchemaError} was raised. */
export type SqlSchemaErrorReason = 'missing_table' | 'permission_denied'

/**
 * Raised by the SQL backends when a table is missing or the DB user lacks the
 * privilege to use/create it. The message says how to fix it; the driver error is
 * kept as `cause`.
 */
export class SqlSchemaError extends Error {
  override readonly name = 'SqlSchemaError'

  constructor(
    message: string,
    /** The table involved. */
    readonly table: string,
    /** Missing table vs. missing privilege. */
    readonly reason: SqlSchemaErrorReason,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export type ResolvedTables = Required<SqlTableNames>

const DEFAULT_TABLES: ResolvedTables = {
  messages: 'momo_messages',
  facts: 'momo_facts',
  runCheckpoints: 'momo_run_checkpoints',
  llmCache: 'momo_llm_cache',
}

const PART_TABLES: Record<SqlSchemaPart, (keyof ResolvedTables)[]> = {
  memory: ['messages', 'facts'],
  runStore: ['runCheckpoints'],
  cache: ['llmCache'],
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/

/** Fill in default names and reject anything that isn't a safe identifier. */
export function resolveTables(names: SqlTableNames = {}): ResolvedTables {
  const tables = { ...DEFAULT_TABLES, ...names }
  for (const [key, name] of Object.entries(tables)) {
    if (!IDENTIFIER.test(name)) {
      throw new TypeError(
        [
          `Invalid table name for "${key}": ${JSON.stringify(name)} — use letters, digits,`,
          'and underscores, optionally prefixed by one schema (e.g. "app.bot_messages").',
        ].join(' '),
      )
    }
  }
  return tables
}

/** The table name without its schema/database prefix (for index names). */
export const bareName = (table: string): string => table.slice(table.lastIndexOf('.') + 1)

/** The parts to create/check, de-duplicated, in DDL order. */
export const selectedParts = (include?: readonly SqlSchemaPart[]): SqlSchemaPart[] =>
  SQL_SCHEMA_PARTS.filter((part) => !include || include.includes(part))

/** The table names behind the selected parts. */
export const tablesFor = (options: SqlSchemaOptions = {}): string[] => {
  const tables = resolveTables(options.tables)
  return selectedParts(options.include).flatMap((part) => PART_TABLES[part].map((k) => tables[k]))
}

type Backend = 'postgres' | 'mysql'

const DDL_HELPER: Record<Backend, string> = { postgres: 'postgresDdl', mysql: 'mysqlDdl' }

/** Classify a `pg` / `mysql2` driver error as a missing table or a missing privilege. */
export function classifySqlError(err: unknown): SqlSchemaErrorReason | undefined {
  const { code, errno } = (err ?? {}) as { code?: unknown; errno?: unknown }
  // pg: 42P01 undefined_table · mysql: 1146 ER_NO_SUCH_TABLE
  if (code === '42P01' || code === 'ER_NO_SUCH_TABLE' || errno === 1146) return 'missing_table'
  // pg: 42501 insufficient_privilege · mysql: 1142 table / 1044 database access denied
  if (
    code === '42501' ||
    code === 'ER_TABLEACCESS_DENIED_ERROR' ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    errno === 1142 ||
    errno === 1044
  ) {
    return 'permission_denied'
  }
  return undefined
}

/** Wrap a driver error raised while USING a table in an actionable {@link SqlSchemaError}. */
export function explainQueryError(err: unknown, table: string, backend: Backend): unknown {
  const reason = classifySqlError(err)
  if (!reason) return err
  const pkg = `momo-agentic/${backend}`
  const message =
    reason === 'missing_table'
      ? [
          `${pkg}: table "${table}" does not exist. Create it once — either`,
          '`await ensureSchema(pool)` at boot (needs CREATE privilege), or apply the SQL from',
          `\`${DDL_HELPER[backend]}()\` with your migrations / a DBA. If your tables have`,
          'other names, pass `{ tables: { ... } }` to the backend.',
        ]
      : [
          `${pkg}: this DB user may not use table "${table}".`,
          'Grant it SELECT, INSERT, UPDATE, DELETE on the momo-agentic tables.',
        ]
  return new SqlSchemaError(message.join(' '), table, reason, { cause: err })
}

/** Wrap a privilege error raised by `ensureSchema` with the no-CREATE alternatives. */
export function explainCreateError(err: unknown, table: string, backend: Backend): unknown {
  if (classifySqlError(err) !== 'permission_denied') return err
  return new SqlSchemaError(
    [
      `momo-agentic/${backend}: this DB user may not create table "${table}". Either grant`,
      'CREATE, or skip ensureSchema: have a DBA / your migrations apply the SQL from',
      `\`${DDL_HELPER[backend]}()\`, then call \`checkSchema(pool)\` at boot to verify.`,
    ].join(' '),
    table,
    'permission_denied',
    { cause: err },
  )
}

/**
 * Probe each table with a zero-row SELECT (needs only SELECT privilege, never
 * creates anything) and report which are missing or unreadable.
 */
export async function probeTables(
  tables: readonly string[],
  select: (sql: string) => Promise<unknown>,
): Promise<SqlSchemaReport> {
  const report: SqlSchemaReport = { ok: true, missing: [], denied: [] }
  for (const table of tables) {
    try {
      await select(`SELECT 1 FROM ${table} WHERE 1 = 0`)
    } catch (err) {
      const reason = classifySqlError(err)
      if (reason === 'missing_table') report.missing.push(table)
      else if (reason === 'permission_denied') report.denied.push(table)
      else throw err
    }
  }
  report.ok = report.missing.length === 0 && report.denied.length === 0
  return report
}
