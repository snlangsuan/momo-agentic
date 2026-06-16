import { describe, expect, it } from 'bun:test'
import { Agent, type LanguageModel } from '../index'

const model: LanguageModel = { id: 'm', generate: () => Promise.resolve({ content: 'hello' }) }

describe('RunOptions.hooks', () => {
  it("delivers this run's events to a per-run hook", async () => {
    const seen: string[] = []
    await new Agent({ model }).run('hi', { hooks: { onEvent: (e) => void seen.push(e.type) } })
    expect(seen).toContain('run_start')
    expect(seen).toContain('run_end')
  })

  it('combines with the config hooks (both fire, config first)', async () => {
    const cfg: string[] = []
    const per: string[] = []
    await new Agent({ model, hooks: { onEvent: (e) => void cfg.push(e.type) } }).run('hi', {
      hooks: { onEvent: (e) => void per.push(e.type) },
    })
    expect(cfg).toContain('run_end')
    expect(per).toContain('run_end')
  })

  it('isolates the per-run hook to that single run (no leak)', async () => {
    const seen: string[] = []
    const agent = new Agent({ model })
    await agent.run('a', { hooks: { onEvent: (e) => void seen.push(e.type) } })
    await agent.run('b') // no per-run hook
    expect(seen.filter((t) => t === 'run_end')).toHaveLength(1)
  })
})
