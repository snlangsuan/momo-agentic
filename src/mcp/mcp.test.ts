import { describe, expect, it } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Agent } from '../index'
import { ScriptedModel } from '../test-support/scripted-model'
import { mcpToolProvider } from './client'

/** Spin up an in-memory MCP server exposing an `add` tool, return a client transport. */
async function startServer() {
  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'add',
        description: 'add two numbers',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'add') {
      return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true }
    }
    const { a, b } = req.params.arguments as { a: number; b: number }
    return { content: [{ type: 'text', text: String(a + b) }] }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return clientTransport
}

describe('mcpToolProvider', () => {
  it('lists the remote MCP tools as momo tools (schema mapped)', async () => {
    const provider = mcpToolProvider({ transport: await startServer() })
    const tools = await provider.listTools()

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('add')
    expect(tools[0]?.description).toBe('add two numbers')
    expect(tools[0]?.parameters).toMatchObject({ required: ['a', 'b'] })
    await provider.close?.()
  })

  it('applies a toolPrefix to avoid name collisions', async () => {
    const provider = mcpToolProvider({ transport: await startServer(), toolPrefix: 'math_' })
    const tools = await provider.listTools()
    expect(tools[0]?.name).toBe('math_add')
    await provider.close?.()
  })

  it('executes a remote tool call and maps the text result', async () => {
    const provider = mcpToolProvider({ transport: await startServer() })
    const tools = await provider.listTools()
    const result = await tools[0]?.execute({ a: 2, b: 3 }, { agentName: 't', metadata: {} })
    expect(result).toBe('5')
    await provider.close?.()
  })

  it('drives an Agent end-to-end through the provider', async () => {
    const provider = mcpToolProvider({ transport: await startServer() })
    // The model calls the remote `add` tool, then answers from its result.
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 40, b: 2 } }] },
      { content: 'The sum is 42.' },
    ])
    const agent = new Agent({ model, toolProviders: [provider] })
    const result = await agent.run('add 40 and 2')

    expect(result.toolsInvoked).toEqual(['add'])
    expect(result.output).toBe('The sum is 42.')
    await provider.close?.()
  })

  it('throws when no transport/stdio/url is given (lazily, on first use)', async () => {
    const provider = mcpToolProvider({})
    expect(provider.listTools()).rejects.toThrow('requires one of')
  })
})
