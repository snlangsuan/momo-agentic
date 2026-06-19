/**
 * Redis-backed implementations of momo-agentic's persistence ports, shipped as a
 * separate entry point (`momo-agentic/redis`). `ioredis` is an OPTIONAL peer
 * dependency, imported for types only — the core stays dependency-free.
 */
export { RedisModelCache } from '@/redis/cache'
export type { RedisModelCacheOptions } from '@/redis/cache'
export { RedisMemory } from '@/redis/memory'
export type { RedisMemoryOptions } from '@/redis/memory'
export { RedisRunStore } from '@/redis/run-store'
export type { RedisRunStoreOptions } from '@/redis/run-store'
