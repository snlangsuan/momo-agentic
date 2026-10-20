/**
 * MySQL / MariaDB-backed persistence for momo-agentic, shipped as a separate
 * entry point (`momo-agentic/mysql`). `mysql2` is an OPTIONAL peer dependency,
 * imported for types only — the core stays dependency-free. The tables must exist
 * before first use: create them with {@link ensureSchema} (opt-in, needs CREATE),
 * or apply {@link mysqlDdl} yourself and verify with {@link checkSchema}.
 */
export { MySqlModelCache } from '@/mysql/cache'
export type { MySqlModelCacheOptions } from '@/mysql/cache'
export { MySqlMemory } from '@/mysql/memory'
export { MySqlRunStore } from '@/mysql/run-store'
export { checkSchema, ensureSchema, MYSQL_DDL, mysqlDdl } from '@/mysql/schema'
export { SQL_SCHEMA_PARTS, SqlSchemaError } from '@/shared/sql-schema'
export type {
  SqlSchemaErrorReason,
  SqlSchemaOptions,
  SqlSchemaPart,
  SqlSchemaReport,
  SqlTableNames,
  SqlTableOptions,
} from '@/shared/sql-schema'
