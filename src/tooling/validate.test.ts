import { describe, expect, it } from 'bun:test'
import { validateArguments } from '@/tooling/validate'

describe('validateArguments', () => {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      days: { type: 'integer' },
      detailed: { type: 'boolean' },
    },
    required: ['city'],
  }

  it('passes when required keys are present and types match', () => {
    expect(validateArguments(schema, { city: 'BKK', days: 3, detailed: true })).toBeNull()
  })

  it('reports a missing required property', () => {
    expect(validateArguments(schema, { days: 3 })).toBe('missing required property "city"')
  })

  it('treats an explicit undefined required value as missing', () => {
    expect(validateArguments(schema, { city: undefined })).toBe('missing required property "city"')
  })

  it('reports a wrong primitive type', () => {
    expect(validateArguments(schema, { city: 123 })).toBe('property "city" must be string')
  })

  it('enforces integer vs number', () => {
    expect(validateArguments(schema, { city: 'x', days: 3.5 })).toBe(
      'property "days" must be integer',
    )
  })

  it('accepts a union type when any branch matches', () => {
    const s = { type: 'object', properties: { id: { type: ['string', 'null'] } } }
    expect(validateArguments(s, { id: null })).toBeNull()
    expect(validateArguments(s, { id: 'a' })).toBeNull()
    expect(validateArguments(s, { id: 7 })).toBe('property "id" must be string|null')
  })

  it('ignores properties without a declared type and unknown extras', () => {
    const s = { type: 'object', properties: { anything: {} } }
    expect(validateArguments(s, { anything: 42, extra: 'ok' })).toBeNull()
  })

  it('returns null for an absent schema', () => {
    expect(validateArguments(undefined, { whatever: 1 })).toBeNull()
  })
})
