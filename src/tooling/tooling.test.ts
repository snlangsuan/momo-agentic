import { describe, expect, it } from 'bun:test'
import { ToolRegistry } from '@/tooling/registry'
import { BaseTool, type ToolContext, defineTool, toToolSchema } from '@/tooling/tool'

describe('ToolRegistry', () => {
  const a = defineTool({ name: 'a', description: 'A', execute: () => 'a' })
  const b = defineTool({ name: 'b', description: 'B', execute: () => 'b' })

  it('registers, gets, has, lists in order, and counts', () => {
    const registry = new ToolRegistry().register(a, b)
    expect(registry.size).toBe(2)
    expect(registry.has('a')).toBe(true)
    expect(registry.has('missing')).toBe(false)
    expect(registry.get('b')).toBe(b)
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.list().map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('last registration of a name wins (override)', () => {
    const a2 = defineTool({ name: 'a', description: 'A2', execute: () => 'a2' })
    const registry = new ToolRegistry().register(a).register(a2)
    expect(registry.size).toBe(1)
    expect(registry.get('a')?.description).toBe('A2')
  })
})

describe('toToolSchema', () => {
  it('extracts the provider-neutral schema, dropping execute/directReturn', () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      directReturn: true,
      execute: () => 'x',
    })
    expect(toToolSchema(tool)).toEqual({
      name: 't',
      description: 'd',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    })
  })
})

describe('BaseTool', () => {
  class Echo extends BaseTool<{ text: string }> {
    readonly name = 'echo'
    readonly description = 'echo the input'
    execute({ text }: { text: string }, ctx: ToolContext) {
      return `${ctx.agentName}: ${text}`
    }
  }

  it('defaults parameters to an empty object schema and runs execute', () => {
    const echo = new Echo()
    expect(echo.parameters).toEqual({ type: 'object', properties: {} })
    expect(echo.execute({ text: 'hi' }, { agentName: 'bot', metadata: {} })).toBe('bot: hi')
  })
})
