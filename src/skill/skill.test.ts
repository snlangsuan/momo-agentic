import { describe, expect, it } from 'bun:test'
import { Agent } from '../agent/agent'
import { ScriptedModel } from '../test-support/scripted-model'
import { defineTool } from '../tooling/tool'
import type { Tool } from '../tooling/tool'
import { defineSkillFromManifest, parseSkillManifest } from './manifest'
import { SkillRegistry } from './registry'
import { BaseSkill, defineSkill } from './skill'

const getWeather = defineTool({
  name: 'get_weather',
  description: 'weather',
  execute: () => 'sunny',
})

describe('defineSkill', () => {
  it('bundles tools with an instruction and metadata', () => {
    const skill = defineSkill({
      name: 'weather',
      description: 'Look up weather',
      instruction: 'Use get_weather for weather questions.',
      tools: [getWeather],
      keywords: ['weather'],
      creditCost: 2,
    })
    expect(skill.tools).toHaveLength(1)
    expect(skill.keywords).toEqual(['weather'])
    expect(skill.creditCost).toBe(2)
  })
})

describe('SkillRegistry', () => {
  it('registers skills and flattens their tools', () => {
    const a = defineSkill({ name: 'a', description: '', instruction: 'ia', tools: [getWeather] })
    const b = defineSkill({
      name: 'b',
      description: '',
      instruction: 'ib',
      tools: [defineTool({ name: 'x', description: 'x', execute: () => 'x' })],
    })
    const registry = new SkillRegistry().register(a, b)
    expect(registry.size).toBe(2)
    expect(registry.tools().map((t) => t.name)).toEqual(['get_weather', 'x'])
  })

  it('supports get/has/list', () => {
    const a = defineSkill({ name: 'a', description: '', instruction: 'ia', tools: [] })
    const registry = new SkillRegistry().register(a)
    expect(registry.has('a')).toBe(true)
    expect(registry.has('nope')).toBe(false)
    expect(registry.get('a')).toBe(a)
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.list()).toEqual([a])
  })
})

describe('BaseSkill', () => {
  it('can be subclassed to provide tools and instruction', () => {
    class WeatherSkill extends BaseSkill {
      readonly name = 'weather'
      readonly description = 'Weather lookups'
      readonly instruction = 'Use get_weather.'
      readonly tools: Tool[] = [getWeather]
    }
    const skill = new WeatherSkill()
    expect(skill.name).toBe('weather')
    expect(skill.tools).toEqual([getWeather])
    expect(skill.allowDirectInvoke).toBeUndefined()
  })
})

describe('parseSkillManifest', () => {
  const md = `---
name: web_search
description: Search the web
credit_cost: 3
allow_direct_invoke: false
keywords: [search, web, news]
---
Use web_search for anything current.
Always cite sources.`

  it('parses frontmatter and body', () => {
    const manifest = parseSkillManifest(md)
    expect(manifest.name).toBe('web_search')
    expect(manifest.description).toBe('Search the web')
    expect(manifest.creditCost).toBe(3)
    expect(manifest.allowDirectInvoke).toBe(false)
    expect(manifest.keywords).toEqual(['search', 'web', 'news'])
    expect(manifest.instruction).toContain('cite sources')
  })

  it('builds a skill from a manifest + tools', () => {
    const skill = defineSkillFromManifest(md, [getWeather])
    expect(skill.name).toBe('web_search')
    expect(skill.tools).toEqual([getWeather])
  })

  it('throws when name is missing', () => {
    expect(() => parseSkillManifest('---\ndescription: x\n---\nbody')).toThrow(/name/)
  })
})

describe('Agent + skills', () => {
  it('exposes skill tools and injects skill instructions into the system prompt', async () => {
    const skill = defineSkill({
      name: 'weather',
      description: 'Weather lookups',
      instruction: 'Always answer weather in Celsius.',
      tools: [getWeather],
    })
    const model = new ScriptedModel([{ content: 'ok' }])
    const agent = new Agent({ model, skills: [skill] })

    await agent.run('hi')

    const call = model.calls[0]
    expect(call?.tools.map((t) => t.name)).toContain('get_weather')
    expect(call?.messages[0]?.content).toContain('Always answer weather in Celsius')
  })

  it('reports skillsUsed when a skill tool is invoked', async () => {
    const skill = defineSkill({
      name: 'weather',
      description: '',
      instruction: 'i',
      tools: [getWeather],
    })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }] },
      { content: 'It is sunny.' },
    ])
    const agent = new Agent({ model, skills: [skill] })

    const result = await agent.run('weather?')
    expect(result.skillsUsed).toEqual(['weather'])
  })

  it('reports no skillsUsed when only non-skill tools run', async () => {
    const free = defineTool({ name: 'free', description: 'f', execute: () => 'ok' })
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'free', arguments: {} }] },
      { content: 'done' },
    ])
    const agent = new Agent({ model, tools: [free] })

    const result = await agent.run('go')
    expect(result.skillsUsed).toEqual([])
  })
})
