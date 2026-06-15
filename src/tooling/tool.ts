/**
 * Layer 4 — Tooling.
 *
 * Tools are the agent's operational capabilities (function calling, RAG, code
 * execution, external APIs). This layer offers three ways to author one, from
 * most to least ceremony:
 *
 * 1. `class extends BaseTool` — a prototype class to subclass for stateful tools.
 * 2. `defineTool({...})` — a typed functional helper for simple tools.
 * 3. a plain object implementing {@link Tool} — for full control / adapters.
 */
import type { ToolSchema } from '../shared/types'

/** Execution context handed to a tool when it runs. */
export interface ToolContext {
  /** Name of the agent invoking the tool. */
  agentName: string
  /** Abort signal propagated from the agent run. */
  signal?: AbortSignal
  /** Arbitrary per-run data the host app threads through (userId, tenant, ...). */
  metadata: Record<string, unknown>
}

/**
 * A tool the agent can call.
 *
 * @typeParam TArgs - Shape of the validated arguments object.
 */
export interface Tool<TArgs = Record<string, unknown>> extends ToolSchema {
  /**
   * Run the tool. A non-string return is serialized to JSON before being fed
   * back to the model.
   */
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
  /**
   * If true, the tool's result is returned to the user as the final answer and
   * the reasoning loop exits without another model synthesis pass. The tool
   * should return a `{ message: string }` object or a plain string.
   */
  directReturn?: boolean
  /**
   * If true, the call is routed through the run's `ToolApprover` before it runs.
   * The approver may allow, deny (the model gets an error), or edit the arguments.
   * With no approver configured, a guarded call is denied by default. See
   * {@link ToolApprover}.
   */
  requiresApproval?: boolean
}

/**
 * Prototype base class for authoring tools.
 *
 * Subclass it for tools that need internal state, dependency injection, or
 * shared helpers. `parameters` defaults to an empty object schema.
 *
 * @example
 * ```ts
 * class GetWeather extends BaseTool<{ city: string }> {
 *   readonly name = 'get_weather'
 *   readonly description = 'Get the current weather for a city'
 *   readonly parameters = {
 *     type: 'object',
 *     properties: { city: { type: 'string' } },
 *     required: ['city'],
 *   }
 *   execute({ city }: { city: string }) {
 *     return `It is sunny in ${city}.`
 *   }
 * }
 * ```
 */
export abstract class BaseTool<TArgs = Record<string, unknown>> implements Tool<TArgs> {
  abstract readonly name: string
  abstract readonly description: string
  readonly parameters: Record<string, unknown> = { type: 'object', properties: {} }
  readonly directReturn?: boolean
  readonly requiresApproval?: boolean

  abstract execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
}

/** Configuration accepted by {@link defineTool}. */
export interface ToolDefinition<TArgs> {
  name: string
  description: string
  /** JSON Schema for the parameters object. Defaults to an empty object schema. */
  parameters?: Record<string, unknown>
  directReturn?: boolean
  /** Route the call through the run's `ToolApprover` before executing. */
  requiresApproval?: boolean
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
}

/**
 * Define a strongly-typed tool from a plain definition object.
 *
 * @example
 * ```ts
 * const getWeather = defineTool<{ city: string }>({
 *   name: 'get_weather',
 *   description: 'Get the current weather for a city',
 *   parameters: {
 *     type: 'object',
 *     properties: { city: { type: 'string' } },
 *     required: ['city'],
 *   },
 *   execute: ({ city }) => `It is sunny in ${city}.`,
 * })
 * ```
 */
export function defineTool<TArgs = Record<string, unknown>>(
  definition: ToolDefinition<TArgs>,
): Tool<TArgs> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters ?? { type: 'object', properties: {} },
    directReturn: definition.directReturn,
    requiresApproval: definition.requiresApproval,
    execute: definition.execute,
  }
}

/** Extract the provider-neutral schema from a tool. */
export function toToolSchema(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
