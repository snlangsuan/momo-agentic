/**
 * Prototype base class for building agents.
 *
 * Extend this when you need a custom orchestration (a bespoke loop, a router, a
 * pipeline of models) but still want to plug into the rest of the library:
 * subclasses are automatically usable as tools by other agents (Layer 2) via
 * {@link BaseAgent.asTool}. Implement {@link BaseAgent.run} with your logic.
 *
 * For the standard ReAct behavior, use {@link Agent} instead
 * of subclassing.
 */
import { type AgentAsToolOptions, agentAsTool } from '../network/as-tool'
import type { Tool } from '../tooling/tool'
import type { IAgent, RunOptions, RunResult } from './types'

export abstract class BaseAgent implements IAgent {
  abstract readonly name: string

  abstract run(input: string, options?: RunOptions): Promise<RunResult>

  /** Expose this agent as a tool another agent can delegate to. */
  asTool(options: AgentAsToolOptions): Tool {
    return agentAsTool(this, options)
  }
}
