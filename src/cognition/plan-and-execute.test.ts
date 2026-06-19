import { describe, expect, it } from 'bun:test'
import type { GenerateOptions, ModelResponse } from '@/cognition/model'
import {
  Agent,
  type AgentEvent,
  type LanguageModel,
  PlanAndExecuteStrategy,
  defineTool,
} from '@/index'
import { ScriptedModel } from '@/test-support/scripted-model'

/** Like ScriptedModel but with a caller-chosen `id`, to assert per-model attribution. */
class TaggedModel implements LanguageModel {
  readonly calls: GenerateOptions[] = []
  private step = 0
  constructor(
    readonly id: string,
    private readonly responses: ModelResponse[],
  ) {}
  generate(options: GenerateOptions): Promise<ModelResponse> {
    this.calls.push(options)
    const response = this.responses[this.step] ?? { content: '' }
    this.step++
    return Promise.resolve(response)
  }
}

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

  it('runs planning on `planningModel` while steps and synthesis use the main model', async () => {
    const planner = new TaggedModel('cheap-planner', [planCall(['Do A', 'Do B'])])
    const main = new TaggedModel('main-model', [
      { content: 'did A' }, // step 1
      { content: 'did B' }, // step 2
      { content: 'A and B are done' }, // synthesis
    ])

    const events: AgentEvent[] = []
    const result = await new Agent({
      model: main,
      strategy: new PlanAndExecuteStrategy({ planningModel: planner }),
      hooks: { onEvent: (e) => void events.push(e) },
    }).run('do the work')

    expect(result.output).toBe('A and B are done')
    // The plan call is the only thing routed to the planning model...
    expect(planner.calls).toHaveLength(1)
    expect(planner.calls[0]?.tools?.map((t) => t.name)).toContain('create_plan')
    // ...the two step executions + the synthesis call all go to the main model.
    expect(main.calls).toHaveLength(3)
    expect(main.calls.at(-1)?.tools).toEqual([]) // synthesis offers no tools

    // Each `step` event / trace entry is attributed to the model that produced it:
    // the first (plan) to the planner, the rest (steps + synthesis) to the main.
    const stepModels = events
      .filter((e) => e.type === 'step')
      .map((e) => (e as { model?: string }).model)
    expect(stepModels[0]).toBe(planner.id)
    expect(stepModels.slice(1).every((m) => m === main.id)).toBe(true)
    expect(result.trace[0]?.model).toBe(planner.id)
    expect(result.trace.at(-1)?.model).toBe(main.id)
  })

  it('aggregates result.usageByModel per model when a turn mixes models', async () => {
    const planner = new TaggedModel('cheap-planner', [
      { ...planCall(['Do A']), usage: { inputTokens: 10, outputTokens: 4 } },
    ])
    const main = new TaggedModel('main-model', [
      { content: 'did A', usage: { inputTokens: 30, outputTokens: 6 } }, // step
      { content: 'done', usage: { inputTokens: 20, outputTokens: 5 } }, // synthesis
    ])

    const result = await new Agent({
      model: main,
      strategy: new PlanAndExecuteStrategy({ planningModel: planner }),
    }).run('go')

    expect(result.usageByModel).toEqual({
      'cheap-planner': { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      'main-model': { inputTokens: 50, outputTokens: 11, totalTokens: 61 },
    })
    // The per-model split sums to the run total.
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 15, totalTokens: 75 })
  })

  it('routes re-planning to `planningModel` too', async () => {
    const planner = new ScriptedModel([
      planCall(['A', 'B']), // initial plan
      reviseCall(['B']), // re-plan after step 1
    ])
    const main = new ScriptedModel([
      { content: 'did A' },
      { content: 'did B' },
      { content: 'final' },
    ])

    await new Agent({
      model: main,
      strategy: new PlanAndExecuteStrategy({ planningModel: planner, replan: true, maxReplans: 1 }),
    }).run('go')

    // plan + one re-plan attempt → planning model; 2 steps + synthesis → main model.
    expect(planner.calls).toHaveLength(2)
    expect(main.calls).toHaveLength(3)
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
