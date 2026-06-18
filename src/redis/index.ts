/**
 * Redis-backed implementations of momo-agentic's persistence ports, shipped as a
 * separate entry point (`momo-agentic/redis`). `ioredis` is an OPTIONAL peer
 * dependency, imported for types only — the core stays dependency-free.
 */
export { RedisModelCache } from './cache'
export type { RedisModelCacheOptions } from './cache'
export { RedisMemory } from './memory'
export type { RedisMemoryOptions } from './memory'
export { RedisRunStore } from './run-store'
export type { RedisRunStoreOptions } from './run-store'
