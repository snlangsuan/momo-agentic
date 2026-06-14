import { describe, expect, it } from 'bun:test'
import { Agent } from '../agent/agent'
import { ScriptedModel } from '../test-support/scripted-model'
import { defineTool } from '../tooling/tool'
import { agentAsTool } from './as-tool'

describe('agentAsTool (multi-agent handoff)', () => {
  it('lets a lead agent delegate to a specialist agent via a tool call', async () => {
    // Specialist: a researcher that calls a search tool then answers.
    const search = defineTool({
      name: 'search',
      description: 'search the web',
      execute: () => 'Bangkok is the capital of Thailand',
    })
    const researcher = new Agent({
      name: 'researcher',
      model: new ScriptedModel([
        { content: '', toolCalls: [{ id: 's1', name: 'search', arguments: { q: 'capital' } }] },
        { content: 'The capital of Thailand is Bangkok.' },
      ]),
      tools: [search],
    })

    // Lead delegates to the researcher, then wraps the answer.
    const lead = new Agent({
      name: 'lead',
      model: new ScriptedModel([
        {
          content: '',
          toolCalls: [
            { id: 'd1', name: 'researcher', arguments: { input: 'capital of Thailand?' } },
          ],
        },
        { content: 'Here is what I found: Bangkok.' },
      ]),
      tools: [agentAsTool(researcher, { description: 'Delegate research questions' })],
    })

    const result = await lead.run('What is the capital of Thailand?')
    expect(result.output).toBe('Here is what I found: Bangkok.')
    expect(result.toolsInvoked).toEqual(['researcher'])
  })

  it('uses asTool() from the BaseAgent prototype', () => {
    const agent = new Agent({ name: 'helper', model: new ScriptedModel([{ content: 'hi' }]) })
    const tool = agent.asTool({ description: 'a helper agent' })
    expect(tool.name).toBe('helper')
    expect(tool.parameters).toHaveProperty('properties.input')
  })
})
