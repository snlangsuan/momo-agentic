import type { FactMemory } from '@/memory/memory'
/**
 * A ready-made tool that lets the agent WRITE to long-term memory — closing the
 * loop so facts are not just read but captured during conversation. Bridge the
 * Tooling (Layer 4) and Memory (Layer 6) layers.
 *
 * The default {@link Agent} can auto-register this via the
 * `rememberFacts: true` config; use this factory directly for custom agents.
 */
import { type Tool, defineTool } from '@/tooling/tool'

/** Options for {@link createRememberTool}. */
export interface RememberToolOptions {
  /** Tool name exposed to the model. Defaults to `"remember_fact"`. */
  name?: string
  /** Override the tool description (e.g. to localize). */
  description?: string
}

/**
 * Build a tool that stores a durable fact about the user into `memory`.
 *
 * @example
 * ```ts
 * const memory = new InMemoryMemory()
 * const agent = new Agent({ model, memory, tools: [createRememberTool(memory)] })
 * ```
 */
export function createRememberTool(
  memory: Pick<FactMemory, 'rememberFact'>,
  options: RememberToolOptions = {},
): Tool {
  return defineTool<{ key: string; value: string }>({
    name: options.name ?? 'remember_fact',
    description:
      options.description ??
      'Save or update a durable fact, preference, or detail about the user for future conversations (e.g. name, hobby, allergy, preferred answer length).',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Short category/key, e.g. "name", "hobby", "allergy".',
        },
        value: {
          type: 'string',
          description: 'The fact to remember, e.g. "Somchai", "likes cycling".',
        },
      },
      required: ['key', 'value'],
    },
    execute: async ({ key, value }) => {
      await memory.rememberFact(key, value)
      return { message: `Remembered ${key}: ${value}` }
    },
  })
}
