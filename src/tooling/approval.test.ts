import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, type ToolApprover, defineTool } from '@/index'
import { ScriptedModel } from '@/test-support/scripted-model'

const sendEmail = defineTool({
  name: 'send_email',
  description: 'send an email',
  requiresApproval: true,
  execute: (args) => `sent to ${(args as { to: string }).to}`,
})

const callOnce = () =>
  new ScriptedModel([
    { content: '', toolCalls: [{ id: 'e', name: 'send_email', arguments: { to: 'a@x.com' } }] },
    { content: 'done' },
  ])

describe('Tool approval (human-in-the-loop)', () => {
  it('runs the tool when the approver allows it', async () => {
    const approver: ToolApprover = { name: 'auto-allow', approve: () => ({ decision: 'allow' }) }
    const events: AgentEvent[] = []
    const result = await new Agent({
      model: callOnce(),
      tools: [sendEmail],
      toolApprover: approver,
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('email a@x.com')

    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({ result: 'sent to a@x.com' })
    expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({
      tool: 'send_email',
      decision: 'allow',
    })
    expect(result.output).toBe('done')
  })

  it('blocks the tool and feeds an error back to the model when denied', async () => {
    const approver: ToolApprover = {
      name: 'deny-all',
      approve: () => ({ decision: 'deny', reason: 'not allowed in test' }),
    }
    let executed = false
    const tool = defineTool({
      name: 'send_email',
      description: 'send an email',
      requiresApproval: true,
      execute: () => {
        executed = true
        return 'sent'
      },
    })
    const events: AgentEvent[] = []
    await new Agent({
      model: callOnce(),
      tools: [tool],
      toolApprover: approver,
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    expect(executed).toBe(false)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect((toolResult as { result: { error: string } }).result.error).toContain('not approved')
    expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({ decision: 'deny' })
  })

  it('runs with edited arguments when the approver returns decision: edit', async () => {
    let ranWith: unknown = null
    const tool = defineTool({
      name: 'send_email',
      description: 'send an email',
      requiresApproval: true,
      execute: (args) => {
        ranWith = args
        return 'sent'
      },
    })
    const approver: ToolApprover = {
      name: 'redirect',
      approve: () => ({ decision: 'edit', args: { to: 'safe@x.com' } }),
    }
    await new Agent({ model: callOnce(), tools: [tool], toolApprover: approver }).run('go')
    expect(ranWith).toEqual({ to: 'safe@x.com' })
  })

  it('denies a guarded tool by default when no approver is configured', async () => {
    let executed = false
    const tool = defineTool({
      name: 'send_email',
      description: 'send an email',
      requiresApproval: true,
      execute: () => {
        executed = true
        return 'sent'
      },
    })
    const events: AgentEvent[] = []
    await new Agent({
      model: callOnce(),
      tools: [tool],
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    expect(executed).toBe(false)
    expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({
      decision: 'deny',
      reason: 'no approver configured',
    })
  })

  it('does not gate tools that are not flagged requiresApproval', async () => {
    let approverCalled = false
    const open = defineTool({ name: 'open', description: 'open tool', execute: () => 'ok' })
    const approver: ToolApprover = {
      name: 'spy',
      approve: () => {
        approverCalled = true
        return { decision: 'allow' }
      },
    }
    const model = new ScriptedModel([
      { content: '', toolCalls: [{ id: 'o', name: 'open', arguments: {} }] },
      { content: 'done' },
    ])
    await new Agent({ model, tools: [open], toolApprover: approver }).run('go')
    expect(approverCalled).toBe(false)
  })
})
