/**
 * MySQL / MariaDB-backed persistence for momo-agentic, shipped as a separate
 * entry point (`momo-agentic/mysql`). `mysql2` is an OPTIONAL peer dependency,
 * imported for types only — the core stays dependency-free. Run
 * {@link ensureSchema} once at boot to create the tables.
 */
export { MySqlModelCache } from './cache'
export type { MySqlModelCacheOptions } from './cache'
export { MySqlMemory } from './memory'
export { MySqlRunStore } from './run-store'
export { ensureSchema, MYSQL_DDL } from './schema'
