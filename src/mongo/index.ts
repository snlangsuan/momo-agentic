/**
 * MongoDB-backed memory for momo-agentic, shipped as a separate entry point
 * (`momo-agentic/mongo`). `mongodb` is an OPTIONAL peer dependency, imported for
 * types only — the core stays dependency-free.
 */
export { MongoMemory } from './memory'
export type { MongoMemoryOptions } from './memory'
