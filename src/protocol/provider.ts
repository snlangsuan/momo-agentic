/**
 * Layer 3 — Protocol.
 *
 * A ToolProvider supplies tools from an external source over some protocol
 * (MCP, A2A, an HTTP plugin registry, ...). Because {@link Tool} schemas are
 * plain JSON Schema, an MCP adapter only has to map the remote tool list into
 * `Tool` objects whose `execute` performs the remote call. The agent treats
 * provider-supplied tools exactly like local ones.
 */
import type { Tool } from '@/tooling/tool'

/** A source of externally-defined tools. */
export interface ToolProvider {
  readonly name: string
  /** Discover and return the tools this provider exposes. */
  listTools(): Promise<Tool[]> | Tool[]
  /** Optional teardown (close sockets, child processes, ...). */
  close?(): Promise<void> | void
}

/**
 * Build a {@link ToolProvider} from a static tool list or a loader function.
 * Useful for tests and for wrapping a connection you already established.
 *
 * @example
 * ```ts
 * const provider = defineToolProvider('my-mcp', async () => {
 *   const remote = await mcpClient.listTools()
 *   return remote.map(toMomoTool)
 * })
 * ```
 */
export function defineToolProvider(
  name: string,
  source: Tool[] | (() => Promise<Tool[]> | Tool[]),
  close?: () => Promise<void> | void,
): ToolProvider {
  return {
    name,
    listTools: () => (typeof source === 'function' ? source() : source),
    close,
  }
}

/** Collect tools from several providers concurrently into one flat list. */
export async function collectProviderTools(providers: ToolProvider[]): Promise<Tool[]> {
  const lists = await Promise.all(providers.map((p) => p.listTools()))
  return lists.flat()
}
