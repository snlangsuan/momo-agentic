import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
/**
 * Protocol (Layer 3) — use a real MCP server's tools from an Agent.
 *
 * `mcpToolProvider` (from `momo-agentic/mcp`) connects to a Model Context Protocol
 * server and exposes its tools as a `ToolProvider`, so the Agent calls them like
 * local tools. In production you'd point it at a real server:
 *
 *   mcpToolProvider({ stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } })
 *   mcpToolProvider({ url: 'https://my-mcp-host/mcp', headers: { authorization: 'Bearer …' } })
 *
 * To keep this example self-contained and runnable, it spins up an in-memory MCP
 * server (via the official SDK) and connects over an in-memory transport.
 *
 * Run with:  bun run examples/mcp-tools.ts
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Agent } from '../src/index'
import { mcpToolProvider } from '../src/mcp/client'
import { fnModel } from './_support/mock-model'

// --- An in-memory MCP server exposing one `uppercase` tool ------------------
const server = new Server({ name: 'demo', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'uppercase',
      description: 'uppercase a string',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { text } = req.params.arguments as { text: string }
  return { content: [{ type: 'text', text: text.toUpperCase() }] }
})
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

// --- Wire the MCP server in as a tool provider ------------------------------
const provider = mcpToolProvider({ transport: clientTransport, toolPrefix: 'mcp_' })

// A mock model that calls the remote tool, then reports its result.
const model = fnModel('mock', ({ messages, tools }) => {
  const last = messages.at(-1)
  if (last?.role === 'tool') return { content: `The server replied: ${last.content}` }
  if (tools.some((t) => t.name === 'mcp_uppercase')) {
    return {
      content: '',
      toolCalls: [{ id: '1', name: 'mcp_uppercase', arguments: { text: 'hello' } }],
    }
  }
  return { content: 'done' }
})

const agent = new Agent({ model, toolProviders: [provider] })
const result = await agent.run('shout hello')

console.log(`✅ ${result.output}`)
console.log(`   tools used: ${result.toolsInvoked.join(', ')}`)
await provider.close?.()
