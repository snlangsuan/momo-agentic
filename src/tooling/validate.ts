/**
 * Layer 4 — Tooling (argument validation).
 *
 * A model can hallucinate tool arguments — omit a required field, or send a
 * string where a number is expected. The tool's `parameters` JSON Schema is sent
 * to the model as a hint, but nothing enforces it before {@link Tool.execute}
 * runs. This is a conservative, zero-dependency check that catches the two most
 * common failures — missing `required` keys and wrong top-level primitive types
 * — and turns them into an error the model can see and correct, instead of a
 * crash or a silently wrong call.
 *
 * It validates only the top level (required + each property's declared `type`):
 * deep/nested validation is intentionally out of scope. Plug a real validator
 * (zod, ajv) via {@link Tool.parse} when you need it.
 */

const JSON_TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  null: (v) => v === null,
}

const matchesType = (declared: unknown, value: unknown): boolean => {
  // `type` may be a union (e.g. ['string', 'null']); pass if any branch matches.
  const types = Array.isArray(declared) ? declared : [declared]
  return types.some((t) => {
    const check = typeof t === 'string' ? JSON_TYPE_CHECKS[t] : undefined
    return check ? check(value) : true // unknown/absent type → don't reject
  })
}

/**
 * Validate `args` against a tool's `parameters` JSON Schema (top level only).
 *
 * @returns an error message describing the first problem found, or `null` when
 * the arguments satisfy the schema (or the schema is absent/untyped).
 */
export function validateArguments(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!schema) return null

  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (typeof key === 'string' && (!(key in args) || args[key] === undefined)) {
      return `missing required property "${key}"`
    }
  }

  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const prop = properties[key]
    const declared =
      prop && typeof prop === 'object' ? (prop as Record<string, unknown>).type : undefined
    if (declared !== undefined && !matchesType(declared, value)) {
      const want = Array.isArray(declared) ? declared.join('|') : String(declared)
      return `property "${key}" must be ${want}`
    }
  }

  return null
}
