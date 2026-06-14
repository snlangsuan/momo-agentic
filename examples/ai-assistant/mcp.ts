/**
 * A reusable adapter that turns any MCP server into a momo-agentic
 * {@link ToolProvider} (Layer 3 — Protocol).
 *
 * Because momo-agentic tool parameters are plain JSON Schema, mapping an MCP
 * server's tool list is mechanical: each remote tool becomes a `Tool` whose
 * `execute` calls `client.callTool(...)`. Works for stdio servers (searxng,
 * a knowledge-base server, ...) and Streamable-HTTP servers alike.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool, ToolProvider } from '../../src/index'

export { Client }

const CLIENT_INFO = { name: 'momo-agentic-assistant', version: '0.1.0' }

/** Connect to an MCP server launched as a child process over stdio. */
export async function connectStdioMcp(opts: {
  command: string
  args?: string[]
  env?: Record<string, string>
}): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(
    new StdioClientTransport({ command: opts.command, args: opts.args, env: opts.env }),
  )
  return client
}

/** Connect to an MCP server exposed over Streamable HTTP (preferred for services). */
export async function connectHttpMcp(url: string): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

/**
 * Connect over legacy HTTP+SSE. Prefer {@link connectHttpMcp} (Streamable HTTP);
 * use this only when a gateway exposes the older SSE transport.
 */
export async function connectSseMcp(url: string): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(new SSEClientTransport(new URL(url)))
  return client
}

interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

/** Flatten an MCP tool result's content blocks into a single string. */
function extractText(result: McpCallResult): string {
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block.type === 'text' && block.text ? block.text : JSON.stringify(block)))
    .join('\n')
    .trim()
}

/** Wrap a connected MCP {@link Client} as a {@link ToolProvider}. */
export function createMcpToolProvider(name: string, client: Client): ToolProvider {
  return {
    name,
    listTools: async (): Promise<Tool[]> => {
      const { tools } = await client.listTools()
      return tools.map(
        (remote): Tool => ({
          name: remote.name,
          description: remote.description ?? remote.name,
          parameters: (remote.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
          execute: async (args) => {
            const result = (await client.callTool({
              name: remote.name,
              arguments: args,
            })) as McpCallResult
            const text = extractText(result)
            return result.isError ? { error: text } : text
          },
        }),
      )
    },
    close: () => client.close(),
  }
}
