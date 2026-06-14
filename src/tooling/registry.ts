import type { Tool } from './tool'

/**
 * A name-keyed collection of tools. Last registration of a name wins, so
 * external providers (Layer 3) can override or extend a base toolset.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /** Register one or more tools. Returns `this` for chaining. */
  register(...tools: Tool[]): this {
    for (const tool of tools) {
      this.tools.set(tool.name, tool as Tool)
    }
    return this
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** All registered tools, in insertion order. */
  list(): Tool[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }
}
