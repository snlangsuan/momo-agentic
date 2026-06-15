/**
 * Cost / rate-limit enforcement. A `UsageLimiter` is consulted before each run and
 * may block it (raising `AgentError` tagged `"rate_limit"`); it is told the actual
 * token usage afterwards. `InMemoryUsageLimiter` caps runs and/or cumulative tokens
 * per key — here, per user. Swap in your own port for Redis / billing / time windows.
 *
 * Run with:  bun run examples/rate-limit.ts
 */
import { Agent, AgentError, InMemoryUsageLimiter } from '../src/index'
import { scriptModel } from './_support/mock-model'

// At most 2 runs per user.
const limiter = new InMemoryUsageLimiter({
  maxRuns: 2,
  key: (ctx) => String(ctx.metadata.userId),
})

const agent = new Agent({
  model: scriptModel([{ content: 'ok' }, { content: 'ok' }, { content: 'ok' }]),
  usageLimiter: limiter,
})

const ask = async (n: number) => {
  try {
    await agent.run(`question ${n}`, { metadata: { userId: 'alice' } })
    console.log(`run ${n}: ✅ allowed`)
  } catch (error) {
    if (error instanceof AgentError && error.stage === 'rate_limit') {
      console.log(`run ${n}: ⛔ blocked — ${error.message}`)
    } else {
      throw error
    }
  }
}

await ask(1) // allowed
await ask(2) // allowed
await ask(3) // blocked — alice is over her 2-run budget
