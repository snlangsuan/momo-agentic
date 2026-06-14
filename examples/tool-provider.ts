/**
 * Protocol (Layer 3) — ToolProvider: supply tools from an external source. This
 * shows the non-MCP path with `defineToolProvider` (a static list and a lazy
 * loader) and `collectProviderTools`. For a real MCP adapter, see
 * examples/ai-assistant/mcp.ts.
 *
 * Run with:  bun run examples/tool-provider.ts
 */
import { Agent, collectProviderTools, defineTool, defineToolProvider } from '../src/index'
import { scriptModel } from './_support/mock-model'

// A provider backed by a static list of tools.
const mathProvider = defineToolProvider('math', [
  defineTool<{ a: number; b: number }>({
    name: 'multiply',
    description: 'Multiply two numbers',
    execute: ({ a, b }) => a * b,
  }),
])

// A provider that loads its tools lazily (e.g. after a remote handshake).
const remoteProvider = defineToolProvider('remote', async () => {
  // imagine: const list = await fetchToolCatalog()
  return [
    defineTool({
      name: 'remote_ping',
      description: 'ping a remote service',
      execute: () => 'pong',
    }),
  ]
})

// You can resolve a provider's tools yourself...
console.log(
  'All provider tools:',
  (await collectProviderTools([mathProvider, remoteProvider])).map((t) => t.name),
)

// ...or just hand the providers to the agent; it resolves them at run time.
const model = scriptModel([
  { content: '', toolCalls: [{ id: 'c1', name: 'multiply', arguments: { a: 6, b: 7 } }] },
  { content: 'The answer is 42.' },
])
const agent = new Agent({ model, toolProviders: [mathProvider, remoteProvider] })
const result = await agent.run('multiply 6 by 7')
console.log('Output:', result.output, '| tools:', result.toolsInvoked)
