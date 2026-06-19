/**
 * Layer 2 — Agent Internet (composition).
 *
 * The unit of multi-agent systems here is "an agent is also a tool". Wrapping an
 * agent as a {@link Tool} lets a coordinator agent delegate (hand off) to a
 * specialist agent through the exact same function-calling mechanism it uses for
 * any tool — no special-case routing, no hardcoded agent graph.
 */
import type { IAgent } from '@/agent/types'
import type { Tool, ToolContext } from '@/tooling/tool'

/** Options for {@link agentAsTool}. */
export interface AgentAsToolOptions {
  /** Tool name exposed to the caller. Defaults to the agent's name. */
  name?: string
  /** Tool description telling the caller when to delegate here. */
  description: string
  /** Name of the single string input. Defaults to `"input"`. */
  inputName?: string
}

/**
 * Expose an agent as a tool another agent can call.
 *
 * @example
 * ```ts
 * const research = new Agent({ name: 'researcher', model, tools: [webSearch] })
 * const lead = new Agent({
 *   name: 'lead',
 *   model,
 *   tools: [agentAsTool(research, { description: 'Delegate web research tasks' })],
 * })
 * ```
 */
export function agentAsTool(agent: IAgent, options: AgentAsToolOptions): Tool {
  const inputName = options.inputName ?? 'input'
  return {
    name: options.name ?? agent.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: {
        [inputName]: {
          type: 'string',
          description: 'The task or question to delegate to this agent.',
        },
      },
      required: [inputName],
    },
    execute: async (args: Record<string, unknown>, context: ToolContext) => {
      const input = typeof args[inputName] === 'string' ? (args[inputName] as string) : ''
      const result = await agent.run(input, { signal: context.signal, metadata: context.metadata })
      return { message: result.output }
    },
  }
}
