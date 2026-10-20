/**
 * PostgreSQL-backed persistence for momo-agentic, shipped as a separate entry
 * point (`momo-agentic/postgres`). `pg` is an OPTIONAL peer dependency, imported
 * for types only — the core stays dependency-free. The tables must exist before
 * first use: create them with {@link ensureSchema} (opt-in, needs CREATE), or apply
 * {@link postgresDdl} yourself and verify with {@link checkSchema}.
 */
export { PostgresModelCache } from '@/postgres/cache'
export type { PostgresModelCacheOptions } from '@/postgres/cache'
export { PostgresMemory } from '@/postgres/memory'
export { PostgresRunStore } from '@/postgres/run-store'
export { checkSchema, ensureSchema, POSTGRES_DDL, postgresDdl } from '@/postgres/schema'
export { SQL_SCHEMA_PARTS, SqlSchemaError } from '@/shared/sql-schema'
export type {
  SqlSchemaErrorReason,
  SqlSchemaOptions,
  SqlSchemaPart,
  SqlSchemaReport,
  SqlTableNames,
  SqlTableOptions,
} from '@/shared/sql-schema'
