import type { ToolProvider } from '@/protocol/provider'
import { type Tool, defineTool } from '@/tooling/tool'
/**
 * Layer 3 — Protocol (MCP client).
 *
 * Connect to a real [Model Context Protocol](https://modelcontextprotocol.io)
 * server and expose its tools as a {@link ToolProvider}, so an `Agent` can use
 * them exactly like local tools. Built on the official `@modelcontextprotocol/sdk`
 * (an optional peer dependency); transports for stdio and Streamable HTTP are
 * loaded lazily so you only pull in what you use.
 *
 * Shipped as the `momo-agentic/mcp` subpath to keep the core dependency-free.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Launch a local MCP server as a child process and talk to it over stdio. */
export interface McpStdioConfig {
  /** Executable to spawn, e.g. `'npx'`. */
  command: string
  /** Arguments, e.g. `['-y', '@modelcontextprotocol/server-filesystem', '/tmp']`. */
  args?: string[]
  /** Environment for the child process. Defaults to the SDK's safe default env. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
}

/** Options for {@link mcpToolProvider}. Provide exactly one of `transport`, `stdio`, or `url`. */
export interface McpToolProviderOptions {
  /** Provider name (shown in logs). Defaults to `'mcp'`. */
  name?: string
  /** Identity announced to the server on initialize. */
  client?: { name?: string; version?: string }
  /** Connect by launching a local server over stdio. */
  stdio?: McpStdioConfig
  /** Connect to a Streamable HTTP MCP endpoint. */
  url?: string | URL
  /** Extra HTTP headers (auth, etc.) for the `url` transport. */
  headers?: Record<string, string>
  /**
   * Use a pre-built `@modelcontextprotocol/sdk` transport directly. The most
   * flexible option and the one to use in tests (e.g. `InMemoryTransport`).
   */
  transport?: Transport
  /**
   * Prefix prepended to every remote tool name — use it to avoid collisions when
   * several MCP servers (or local tools) share a name. Defaults to none.
   */
  toolPrefix?: string
}

/** The slice of an MCP tool-call result this adapter reads. */
interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
  structuredContent?: unknown
}

/** Build the SDK transport from the options (transports are imported lazily). */
async function buildTransport(options: McpToolProviderOptions): Promise<Transport> {
  if (options.transport) return options.transport
  if (options.stdio) {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport(options.stdio)
  }
  if (options.url) {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )
    const url = options.url instanceof URL ? options.url : new URL(options.url)
    return new StreamableHTTPClientTransport(
      url,
      options.headers ? { requestInit: { headers: options.headers } } : undefined,
    )
  }
  throw new Error('mcpToolProvider requires one of: transport, stdio, or url')
}

/** Reduce an MCP call result to a value the reasoning loop can use. */
function mapCallResult(result: McpCallResult): unknown {
  // Prefer the structured payload (MCP structured tool output) when present.
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  if (result.isError) return { error: text || 'MCP tool returned an error' }
  return text
}

/** Wrap one remote MCP tool as a momo {@link Tool} that calls it on demand. */
function toMomoTool(
  getClient: () => Promise<Client>,
  remote: { name: string; description?: string; inputSchema?: unknown },
  prefix?: string,
): Tool {
  // Copy out only the fields the call needs, so the execute closure doesn't pin
  // the whole `remote` object (incl. a potentially large `inputSchema`) in memory.
  const remoteName = remote.name
  return defineTool({
    name: prefix ? `${prefix}${remoteName}` : remoteName,
    description: remote.description ?? '',
    parameters: (remote.inputSchema as Record<string, unknown>) ?? {
      type: 'object',
      properties: {},
    },
    execute: async (args, ctx) => {
      const client = await getClient()
      const result = await client.callTool(
        { name: remoteName, arguments: args as Record<string, unknown> },
        undefined,
        { signal: ctx.signal },
      )
      return mapCallResult(result as McpCallResult)
    },
  })
}

/**
 * Build a {@link ToolProvider} backed by a remote MCP server. The connection is
 * established lazily on first {@link ToolProvider.listTools} and reused for every
 * tool call; {@link ToolProvider.close} disconnects.
 *
 * @example
 * ```ts
 * import { mcpToolProvider } from 'momo-agentic/mcp'
 *
 * const fs = mcpToolProvider({
 *   stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
 *   toolPrefix: 'fs_',
 * })
 * const agent = new Agent({ model, toolProviders: [fs] })
 * // ... when done:
 * await fs.close()
 * ```
 */
export function mcpToolProvider(options: McpToolProviderOptions): ToolProvider {
  const name = options.name ?? 'mcp'
  let clientPromise: Promise<Client> | undefined

  const getClient = (): Promise<Client> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const transport = await buildTransport(options)
        const client = new Client({
          name: options.client?.name ?? 'momo-agentic',
          version: options.client?.version ?? '0.0.0',
        })
        await client.connect(transport)
        return client
      })()
    }
    return clientPromise
  }

  return {
    name,
    async listTools(): Promise<Tool[]> {
      const client = await getClient()
      const { tools } = await client.listTools()
      return tools.map((tool) => toMomoTool(getClient, tool, options.toolPrefix))
    },
    async close(): Promise<void> {
      if (!clientPromise) return
      const client = await clientPromise
      clientPromise = undefined
      await client.close()
    },
  }
}
