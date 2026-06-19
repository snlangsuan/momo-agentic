import { describe, expect, it } from 'bun:test'
import {
  Agent,
  AgentError,
  type AgentEvent,
  InMemoryUsageLimiter,
  type UsageLimiter,
} from '@/index'
import { ScriptedModel } from '@/test-support/scripted-model'

const model = () =>
  new ScriptedModel([{ content: 'ok', usage: { inputTokens: 10, outputTokens: 5 } }])

describe('InMemoryUsageLimiter', () => {
  it('allows runs up to maxRuns, then blocks with AgentError(rate_limit)', async () => {
    const limiter = new InMemoryUsageLimiter({ maxRuns: 2 })
    const agent = new Agent({ model: model(), usageLimiter: limiter })

    await agent.run('1')
    await agent.run('2')
    await expect(agent.run('3')).rejects.toMatchObject({ name: 'AgentError', stage: 'rate_limit' })
  })

  it('blocks once the cumulative token budget is exhausted', async () => {
    const limiter = new InMemoryUsageLimiter({ maxTokens: 10 }) // each run uses 15 total
    const agent = new Agent({ model: model(), usageLimiter: limiter })

    await agent.run('1') // acquire: 0 < 10 → allowed; records 15
    await expect(agent.run('2')).rejects.toBeInstanceOf(AgentError) // acquire: 15 >= 10 → blocked
  })

  it('keys budgets independently per user', async () => {
    const limiter = new InMemoryUsageLimiter({
      maxRuns: 1,
      key: (ctx) => String(ctx.metadata.userId),
    })
    const agent = new Agent({ model: model(), usageLimiter: limiter })

    await agent.run('a', { metadata: { userId: 'alice' } })
    await agent.run('b', { metadata: { userId: 'bob' } }) // different user — allowed
    await expect(agent.run('a2', { metadata: { userId: 'alice' } })).rejects.toMatchObject({
      stage: 'rate_limit',
    })
  })

  it('reset() clears the counters', async () => {
    const limiter = new InMemoryUsageLimiter({ maxRuns: 1 })
    const agent = new Agent({ model: model(), usageLimiter: limiter })
    await agent.run('1')
    limiter.reset()
    await expect(agent.run('2')).resolves.toHaveProperty('output') // allowed again (not blocked)
  })
})

describe('UsageLimiter wiring', () => {
  it('emits an error event tagged rate_limit and never calls the model when blocked', async () => {
    const blocker: UsageLimiter = {
      name: 'always-block',
      acquire: () => ({ allowed: false, reason: 'over quota' }),
    }
    const scripted = model()
    const events: AgentEvent[] = []
    await expect(
      new Agent({
        model: scripted,
        usageLimiter: blocker,
        hooks: { onEvent: (e) => void events.push(e) },
      }).run('go'),
    ).rejects.toMatchObject({ stage: 'rate_limit' })

    expect(scripted.calls).toHaveLength(0) // blocked before any model call
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ stage: 'rate_limit' })
  })

  it('records actual usage after a successful run', async () => {
    const recorded: number[] = []
    const limiter: UsageLimiter = {
      name: 'recorder',
      acquire: () => ({ allowed: true }),
      record: (usage) => void recorded.push(usage.totalTokens),
    }
    await new Agent({ model: model(), usageLimiter: limiter }).run('go')
    expect(recorded).toEqual([15]) // 10 input + 5 output
  })
})
