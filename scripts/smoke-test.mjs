/**
 * Smoke test for the BUILT artifacts in dist/.
 *
 * Loads every published entry point in BOTH module systems — ESM `import` and CJS
 * `require` — under the real Node runtime (where consumers run), then exercises
 * the core (defineTool + new Agent) to prove the bundle isn't just parseable but
 * usable. Catches bundling regressions that the source-level `bun test` can't —
 * e.g. a circular import surfacing as `import_xxx is not defined`, or a broken
 * CJS/ESM interop — before they reach an app that imports the package.
 *
 * Run after `bun run build`:  node scripts/smoke-test.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esmUrl = (rel) => new URL(rel, import.meta.url).href
const cjsPath = (rel) => fileURLToPath(new URL(rel, import.meta.url))

const failures = []
const ok = (label) => console.log(`  ✓ ${label}`)
const fail = (label, err) => {
  console.error(`  ✗ ${label}: ${err.message}`)
  failures.push(label)
}

// [name, esm path, cjs path, a named export that must be a function]
const entries = [
  ['index', '../dist/index.js', '../dist/index.cjs', 'Agent'],
  ['mcp', '../dist/mcp.js', '../dist/mcp.cjs', 'mcpToolProvider'],
  ['a2a', '../dist/a2a.js', '../dist/a2a.cjs', 'serveA2A'],
  ['anthropic', '../dist/anthropic.js', '../dist/anthropic.cjs', 'createAnthropicModel'],
  ['gemini', '../dist/gemini.js', '../dist/gemini.cjs', 'createGeminiModel'],
  ['openai', '../dist/openai.js', '../dist/openai.cjs', 'createOpenAIModel'],
  ['redis', '../dist/redis.js', '../dist/redis.cjs', 'RedisMemory'],
  ['mongo', '../dist/mongo.js', '../dist/mongo.cjs', 'MongoMemory'],
  ['postgres', '../dist/postgres.js', '../dist/postgres.cjs', 'PostgresMemory'],
  ['mysql', '../dist/mysql.js', '../dist/mysql.cjs', 'MySqlMemory'],
]

const check = (mod, named) => {
  if (typeof mod[named] !== 'function')
    throw new Error(`export \`${named}\` missing or not a function`)
}

for (const [name, esm, cjs, named] of entries) {
  try {
    check(await import(esmUrl(esm)), named)
    ok(`esm  ${name} → ${named}`)
  } catch (err) {
    fail(`esm  ${name}`, err)
  }
  try {
    check(require(cjsPath(cjs)), named)
    ok(`cjs  ${name} → ${named}`)
  } catch (err) {
    fail(`cjs  ${name}`, err)
  }
}

// Not just loadable — actually usable. Exercise the core in both module systems.
const stubModel = { id: 'smoke', generate: async () => ({ content: '' }) }

try {
  const { defineTool, Agent } = await import(esmUrl('../dist/index.js'))
  const tool = defineTool({ name: 'noop', description: 'd', execute: () => 'ok' })
  if (tool.name !== 'noop') throw new Error('defineTool returned an unexpected shape')
  if (new Agent({ model: stubModel }).name !== 'agent') throw new Error('Agent default name wrong')
  ok('exercise esm core (defineTool + new Agent)')
} catch (err) {
  fail('exercise esm core', err)
}

try {
  const cjs = require(cjsPath('../dist/index.cjs'))
  const tool = cjs.defineTool({ name: 'noop', description: 'd', execute: () => 'ok' })
  if (tool.name !== 'noop') throw new Error('cjs defineTool returned an unexpected shape')
  if (new cjs.Agent({ model: stubModel }).name !== 'agent')
    throw new Error('cjs Agent default name wrong')
  ok('exercise cjs core (defineTool + new Agent)')
} catch (err) {
  fail('exercise cjs core', err)
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED — ${failures.length} issue(s): ${failures.join(', ')}`)
  console.error(
    'Hint: this tests the built dist/. If it is stale or missing, rebuild first:\n' +
      '      bun run build   (or run `bun run smoke:build` to build + smoke in one step)',
  )
  process.exit(1)
}
console.log('\nSMOKE OK — every built entry loads & the core runs in both ESM and CJS')
