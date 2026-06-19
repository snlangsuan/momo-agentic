import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@/observability/hooks'
import {
  BUILTIN_REDACTION_RULES,
  createRedactor,
  redactHooks,
  redactModel,
} from '@/observability/redaction'
import { ScriptedModel } from '@/test-support/scripted-model'

describe('createRedactor', () => {
  it('tokenizes built-in PII and restores it round-trip', () => {
    const r = createRedactor()
    const safe = r.redact('mail a@b.com and call +1 415 555 1234')

    expect(safe).not.toContain('a@b.com')
    expect(safe).toContain('[REDACTED_EMAIL_1]')
    expect(r.restore(safe)).toBe('mail a@b.com and call +1 415 555 1234')
  })

  it('gives the same value a stable token and counts distinct values', () => {
    const r = createRedactor()
    const safe = r.redact('from a@b.com to c@d.com, reply a@b.com')

    expect(safe).toContain('[REDACTED_EMAIL_1]')
    expect(safe).toContain('[REDACTED_EMAIL_2]')
    // a@b.com reused → still token 1, not a third token
    expect(safe.match(/REDACTED_EMAIL_1/g)).toHaveLength(2)
    expect(r.size).toBe(2)
  })

  it('redacts caller-supplied exact values', () => {
    const r = createRedactor({ values: ['hunter2', 'Acme Corp'] })
    const safe = r.redact('user Acme Corp password hunter2')

    expect(safe).not.toContain('hunter2')
    expect(safe).not.toContain('Acme Corp')
    expect(r.restore(safe)).toBe('user Acme Corp password hunter2')
  })

  it('masks irreversibly with category tags', () => {
    const r = createRedactor()
    const masked = r.mask('card 4111 1111 1111 1111 ssn 123-45-6789')

    expect(masked).toContain('[CREDIT_CARD]')
    expect(masked).toContain('[SSN]')
    expect(masked).not.toContain('4111')
  })

  it('uses a rule-specific mask when provided (partial email)', () => {
    expect(createRedactor().mask('write to alice@example.com')).toBe('write to a***@example.com')
  })

  it('leaves empty text untouched', () => {
    const r = createRedactor()
    expect(r.redact('')).toBe('')
    expect(r.mask('')).toBe('')
    expect(r.restore('')).toBe('')
  })

  it('honors custom rules and placeholder format', () => {
    const r = createRedactor({
      rules: [{ name: 'ticket', pattern: /JIRA-\d+/g }],
      placeholder: (name, i) => `<${name}:${i}>`,
    })
    const safe = r.redact('see JIRA-42')

    expect(safe).toBe('see <TICKET:1>')
    expect(r.restore(safe)).toBe('see JIRA-42')
  })
})

describe('redactModel', () => {
  it('hides values before the model and restores them in the response', async () => {
    const model = new ScriptedModel([{ content: 'I sent it to [REDACTED_EMAIL_1] as requested.' }])
    const guarded = redactModel(model)

    const res = await guarded.generate({
      messages: [{ role: 'user', content: 'email the report to a@b.com' }],
      tools: [],
    })

    // The provider never saw the real email...
    expect(model.calls[0]?.messages[0]?.content).toBe('email the report to [REDACTED_EMAIL_1]')
    // ...but the caller gets the real value back.
    expect(res.content).toBe('I sent it to a@b.com as requested.')
  })

  it('restores values inside tool-call arguments', async () => {
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [{ id: '1', name: 'send', arguments: { to: '[REDACTED_EMAIL_1]' } }],
      },
    ])
    const guarded = redactModel(model)

    const res = await guarded.generate({
      messages: [{ role: 'user', content: 'send to a@b.com' }],
      tools: [],
    })

    expect(res.toolCalls?.[0]?.arguments.to).toBe('a@b.com')
  })

  it('does not expose generateStream (forces the buffered path)', () => {
    expect(redactModel(new ScriptedModel([])).generateStream).toBeUndefined()
  })

  it('preserves the underlying model id', () => {
    expect(redactModel(new ScriptedModel([])).id).toBe('scripted-test-model')
  })
})

describe('redactHooks', () => {
  it('masks sensitive data in events before the inner listener sees it', () => {
    const seen: AgentEvent[] = []
    const hooks = redactHooks({ onEvent: (e) => void seen.push(e) })

    hooks.onEvent?.({ type: 'run_start', agent: 'a', input: 'reach me at a@b.com' })
    hooks.onEvent?.({
      type: 'run_end',
      agent: 'a',
      output: 'done, ssn 123-45-6789',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })

    const start = seen[0] as Extract<AgentEvent, { type: 'run_start' }>
    const end = seen[1] as Extract<AgentEvent, { type: 'run_end' }>
    expect(start.input).toBe('reach me at a***@b.com')
    expect(end.output).toContain('[SSN]')
    expect(end.output).not.toContain('123-45-6789')
  })

  it('masks nested tool-call args and results', () => {
    const seen: AgentEvent[] = []
    const hooks = redactHooks({ onEvent: (e) => void seen.push(e) })

    hooks.onEvent?.({
      type: 'tool_result',
      agent: 'a',
      step: 1,
      tool: 'lookup',
      result: { contact: { email: 'a@b.com' } },
    })

    const ev = seen[0] as Extract<AgentEvent, { type: 'tool_result' }>
    expect(ev.result).toEqual({ contact: { email: 'a***@b.com' } })
  })

  it('passes through events with no sensitive payload', () => {
    const seen: AgentEvent[] = []
    const hooks = redactHooks({ onEvent: (e) => void seen.push(e) })
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

    hooks.onEvent?.({ type: 'step', agent: 'a', step: 1, usage })
    expect(seen[0]).toEqual({ type: 'step', agent: 'a', step: 1, usage })
  })
})

describe('redactHooks — every maskable event type', () => {
  it('masks thinking / token / plan / tool_approval / output / guardrail', () => {
    const seen: AgentEvent[] = []
    const hooks = redactHooks({ onEvent: (e) => void seen.push(e) })
    hooks.onEvent?.({ type: 'thinking', agent: 'a', text: 'mail a@b.com' })
    hooks.onEvent?.({ type: 'token', agent: 'a', delta: 'a@b.com' })
    hooks.onEvent?.({ type: 'plan', agent: 'a', mode: 'use_tools', reason: 'mail a@b.com' })
    hooks.onEvent?.({
      type: 'tool_approval',
      agent: 'a',
      step: 1,
      tool: 't',
      decision: 'deny',
      reason: 'a@b.com leak',
    })
    hooks.onEvent?.({ type: 'output', agent: 'a', value: { email: 'a@b.com' }, final: true })
    hooks.onEvent?.({
      type: 'guardrail',
      agent: 'a',
      name: 'g',
      stage: 'output',
      reason: 'a@b.com',
    })

    expect((seen[0] as Extract<AgentEvent, { type: 'thinking' }>).text).toBe('mail a***@b.com')
    expect((seen[1] as Extract<AgentEvent, { type: 'token' }>).delta).toBe('a***@b.com')
    expect((seen[2] as Extract<AgentEvent, { type: 'plan' }>).reason).toBe('mail a***@b.com')
    expect((seen[3] as Extract<AgentEvent, { type: 'tool_approval' }>).reason).toContain(
      'a***@b.com',
    )
    expect((seen[4] as Extract<AgentEvent, { type: 'output' }>).value).toEqual({
      email: 'a***@b.com',
    })
    expect((seen[5] as Extract<AgentEvent, { type: 'guardrail' }>).reason).toBe('a***@b.com')
  })

  it('masks content and tool-call arguments inside a message event', () => {
    const seen: AgentEvent[] = []
    redactHooks({ onEvent: (e) => void seen.push(e) }).onEvent?.({
      type: 'message',
      agent: 'a',
      message: {
        role: 'assistant',
        content: 'sending to a@b.com',
        toolCalls: [{ id: '1', name: 'send', arguments: { to: 'a@b.com' } }],
      },
    })
    const ev = seen[0] as Extract<AgentEvent, { type: 'message' }>
    expect(ev.message.content).toBe('sending to a***@b.com')
    expect(ev.message.toolCalls?.[0]?.arguments.to).toBe('a***@b.com')
  })

  it('passes a plan/guardrail event through unchanged when it has no reason', () => {
    const seen: AgentEvent[] = []
    redactHooks({ onEvent: (e) => void seen.push(e) }).onEvent?.({
      type: 'plan',
      agent: 'a',
      mode: 'respond',
    })
    expect(seen[0]).toEqual({ type: 'plan', agent: 'a', mode: 'respond' })
  })
})

describe('BUILTIN_REDACTION_RULES', () => {
  it('every rule uses a global pattern so replace catches all matches', () => {
    for (const rule of BUILTIN_REDACTION_RULES) {
      expect(rule.pattern.global).toBe(true)
    }
  })
})
