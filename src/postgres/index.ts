/**
 * PostgreSQL-backed persistence for momo-agentic, shipped as a separate entry
 * point (`momo-agentic/postgres`). `pg` is an OPTIONAL peer dependency, imported
 * for types only — the core stays dependency-free. Run {@link ensureSchema} once
 * at boot to create the tables.
 */
export { PostgresModelCache } from '@/postgres/cache'
export type { PostgresModelCacheOptions } from '@/postgres/cache'
export { PostgresMemory } from '@/postgres/memory'
export { PostgresRunStore } from '@/postgres/run-store'
export { ensureSchema, POSTGRES_DDL } from '@/postgres/schema'
