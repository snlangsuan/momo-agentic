/**
 * Structured / typed final output.
 *
 * When an {@link AgentConfig.responseSchema} is configured, the agent exposes a
 * synthetic `respond` tool whose parameters ARE the desired answer shape (a JSON
 * Schema). The model delivers its final answer by calling that tool; because the
 * tool is `directReturn`, its arguments become the turn's result with the object
 * preserved on {@link RunResult.object}. An optional `parse` validates/coerces it
 * (plug zod/ajv); a light built-in check enforces the schema's `required` keys.
 */
import { type Tool, defineTool } from '../tooling/tool'

/** Declares the structured shape the agent's final answer must take. */
export interface ResponseSchema<T = unknown> {
  /** Name of the synthetic tool the model calls to deliver the answer. Default `'respond'`. */
  name?: string
  /** Description shown to the model for the synthetic tool. */
  description?: string
  /** JSON Schema for the answer object (used as the tool's parameters). */
  schema: Record<string, unknown>
  /**
   * Optional validator/coercer applied to the model's object. Throw to reject —
   * plug a zod/ajv parser here for strict validation. Its return value becomes
   * {@link RunResult.object}.
   */
  parse?: (data: unknown) => T
}

/** Default name of the synthetic structured-answer tool. */
export const RESPONSE_TOOL_NAME = 'respond'

/** Build the synthetic `directReturn` tool that captures the structured answer. */
export function createResponseTool(spec: ResponseSchema): Tool {
  return defineTool({
    name: spec.name ?? RESPONSE_TOOL_NAME,
    description:
      spec.description ??
      'Deliver the final answer to the user as a structured object matching this schema. Call this exactly once, when you are done.',
    parameters: spec.schema,
    directReturn: true,
    execute: (args) => args, // the structured object IS the result
  })
}

/** System-prompt line instructing the model to answer via the structured tool. */
export function responseInstruction(name: string): string {
  return `When you have the final answer, you MUST deliver it by calling the \`${name}\` tool with a structured object matching its schema. Do not answer in plain text.`
}

/** Best-effort `required`-keys check (built-in, dependency-free). Throws on miss. */
export function assertSchema(data: unknown, schema: Record<string, unknown>): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error('structured response is not an object')
  }
  const required = schema.required
  if (Array.isArray(required)) {
    const obj = data as Record<string, unknown>
    const missing = required.filter((key) => typeof key === 'string' && !(key in obj))
    if (missing.length > 0) {
      throw new Error(`structured response is missing required field(s): ${missing.join(', ')}`)
    }
  }
}
