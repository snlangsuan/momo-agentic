import { describe, expect, it } from 'bun:test'
import { Agent, type AgentEvent, PlanAndExecuteStrategy, defineTool } from '../index'
import { ScriptedModel } from '../test-support/scripted-model'

const planCall = (steps: string[]) => ({
  content: '',
  toolCalls: [{ id: 'p', name: 'create_plan', arguments: { steps } }],
})

const reviseCall = (steps: string[]) => ({
  content: '',
  toolCalls: [{ id: 'r', name: 'revise_plan', arguments: { steps } }],
})

const stepPromptsOf = (messages: { role: string; content: string }[]) =>
  messages
    .filter((m) => m.role === 'user' && m.content.startsWith('Execute step'))
    .map((m) => m.content)

describe('PlanAndExecuteStrategy', () => {
  it('plans via create_plan, executes each step, then synthesizes the final answer', async () => {
    const model = new ScriptedModel([
      planCall(['Do A', 'Do B']), // phase 1: plan
      { content: 'did A' }, // step 1 (no tools → ends immediately)
      { content: 'did B' }, // step 2
      { content: 'A and B are done' }, // phase 3: synthesis
    ])
    const events: AgentEvent[] = []
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy(),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('do the work')

    expect(result.output).toBe('A and B are done')
    // plan (1) + step 1 (1) + step 2 (1) + synthesis (1) model calls.
    expect(result.steps).toBe(4)

    // The plan is surfaced via a `plan` event for observability.
    const plan = events.find((e) => e.type === 'plan')
    expect(plan).toMatchObject({ mode: 'plan-and-execute' })
    expect((plan as { reason: string }).reason).toBe('1. Do A\n2. Do B')

    // Each step was injected into the transcript in order.
    const stepPrompts = result.messages
      .filter((m) => m.role === 'user' && m.content.startsWith('Execute step'))
      .map((m) => m.content)
    expect(stepPrompts).toHaveLength(2)
    expect(stepPrompts[0]).toContain('step 1 of 2: Do A')
    expect(stepPrompts[1]).toContain('step 2 of 2: Do B')
  })

  it('lets a single step call real tools via the inner ReAct executor', async () => {
    let calledWith: unknown = null
    const weather = defineTool({
      name: 'weather',
      description: 'look up the weather',
      execute: (args) => {
        calledWith = args
        return 'sunny'
      },
    })
    const model = new ScriptedModel([
      planCall(['Check the weather in BKK']),
      { content: '', toolCalls: [{ id: 'w', name: 'weather', arguments: { city: 'BKK' } }] },
      { content: 'It is sunny in BKK.' }, // step 1 final
      { content: 'The weather in Bangkok is sunny.' }, // synthesis
    ])

    const result = await new Agent({
      model,
      tools: [weather],
      strategy: new PlanAndExecuteStrategy(),
    }).run('how is the weather?')

    expect(calledWith).toEqual({ city: 'BKK' })
    expect(result.toolsInvoked).toEqual(['weather'])
    expect(result.output).toBe('The weather in Bangkok is sunny.')
  })

  it('falls back to parsing a numbered list when the model does not call create_plan', async () => {
    const model = new ScriptedModel([
      { content: '1. First thing\n2. Second thing' }, // plan as plain text
      { content: 'done first' },
      { content: 'done second' },
      { content: 'finished' },
    ])
    const events: AgentEvent[] = []
    await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy(),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    const plan = events.find((e) => e.type === 'plan') as { reason: string }
    expect(plan.reason).toBe('1. First thing\n2. Second thing')
  })

  it('degrades to a single step over the original request when no plan is produced', async () => {
    const model = new ScriptedModel([
      { content: '' }, // empty plan, no tool call
      { content: 'handled the request' }, // single step
      { content: 'all set' }, // synthesis
    ])
    const events: AgentEvent[] = []
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy(),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('just answer me')

    const plan = events.find((e) => e.type === 'plan') as { reason: string }
    expect(plan.reason).toBe('1. just answer me')
    expect(result.output).toBe('all set')
    expect(result.steps).toBe(3) // plan + 1 step + synthesis
  })

  it('caps the plan at maxPlanSteps and reports the truncation', async () => {
    const model = new ScriptedModel([
      planCall(['a', 'b', 'c']),
      { content: 'r1' },
      { content: 'r2' },
      { content: 'done' },
    ])
    const events: AgentEvent[] = []
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy({ maxPlanSteps: 2 }),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    const plan = events.find((e) => e.type === 'plan') as { reason: string }
    expect(plan.reason).toContain('step cap')
    // Only two steps executed despite a three-step plan.
    const stepPrompts = result.messages.filter(
      (m) => m.role === 'user' && m.content.startsWith('Execute step'),
    )
    expect(stepPrompts).toHaveLength(2)
  })

  it('re-plans the remaining steps after a step when `replan` is on', async () => {
    const model = new ScriptedModel([
      planCall(['A', 'B']),
      { content: 'did A' }, // step A
      reviseCall(['B2', 'C']), // replace remaining [B] with [B2, C]
      { content: 'did B2' },
      { content: 'did C' },
      { content: 'all done' }, // synthesis
    ])
    const events: AgentEvent[] = []
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy({ replan: true, maxReplans: 1 }),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('go')

    // Original B was dropped; the revised B2 + C ran instead.
    const prompts = stepPromptsOf(result.messages)
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('A')
    expect(prompts[1]).toContain('B2')
    expect(prompts[2]).toContain('C')

    // A second `plan` event marks the revision.
    const planEvents = events.filter((e) => e.type === 'plan') as { reason: string }[]
    expect(planEvents).toHaveLength(2)
    expect(planEvents[1]?.reason).toContain('revised')
    expect(result.output).toBe('all done')
  })

  it('finishes early when a re-plan returns no remaining steps', async () => {
    const model = new ScriptedModel([
      planCall(['A', 'B']),
      { content: 'did A' },
      reviseCall([]), // nothing left to do
      { content: 'wrapped up' }, // synthesis
    ])
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy({ replan: true, maxReplans: 1 }),
    }).run('go')

    expect(stepPromptsOf(result.messages)).toHaveLength(1) // only step A ran
    expect(result.output).toBe('wrapped up')
  })

  it('leaves the plan intact when the model declines to re-plan', async () => {
    const model = new ScriptedModel([
      planCall(['A', 'B']),
      { content: 'did A' },
      { content: 'plan still looks good' }, // no revise_plan tool call → no change
      { content: 'did B' },
      { content: 'finished' }, // synthesis
    ])
    const result = await new Agent({
      model,
      strategy: new PlanAndExecuteStrategy({ replan: true, maxReplans: 1 }),
    }).run('go')

    expect(stepPromptsOf(result.messages).map((p) => p.match(/: (\w)/)?.[1])).toEqual(['A', 'B'])
    expect(result.messages.some((m) => m.content.startsWith('Revised plan'))).toBe(false)
    expect(result.output).toBe('finished')
  })

  it('accumulates usage across planning, steps, and synthesis', async () => {
    const model = new ScriptedModel([
      { ...planCall(['only step']), usage: { inputTokens: 10, outputTokens: 2 } },
      { content: 'step done', usage: { inputTokens: 5, outputTokens: 3 } },
      { content: 'final', usage: { inputTokens: 4, outputTokens: 1 } },
    ])
    const result = await new Agent({ model, strategy: new PlanAndExecuteStrategy() }).run('go')

    expect(result.usage).toEqual({ inputTokens: 19, outputTokens: 6, totalTokens: 25 })
  })
})
