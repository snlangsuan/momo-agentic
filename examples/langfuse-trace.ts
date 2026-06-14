/**
 * Langfuse-style tracing (Layers 7 + 8).
 *
 * momo-agentic's event stream maps 1:1 onto Langfuse's model:
 *   run            → trace        (name, input, output, latency)
 *   model call     → generation   (usage tokens, output, latency)   ← `step` + `thinking`
 *   tool execution → span         (input args, output result, latency) ← `tool_call`/`tool_result`
 *
 * `createLangfuseCollector` is a hook that builds that nested trace as the run
 * happens. This example prints the Langfuse-shaped object (runs offline); the
 * commented block shows how to forward the same events to the real `langfuse` SDK.
 *
 * Run with:  bun run examples/langfuse-trace.ts
 */
import {
  Agent,
  type AgentEvent,
  type AgentHooks,
  type LanguageModel,
  defineTool,
} from '../src/index'

interface Observation {
  type: 'generation' | 'span'
  name: string
  startTime: number
  endTime?: number
  latencyMs?: number
  input?: unknown
  output?: unknown
  usage?: { input: number; output: number; total: number }
}
interface LangfuseTrace {
  name: string
  input?: string
  output?: unknown
  startTime: number
  endTime?: number
  latencyMs?: number
  observations: Observation[]
}

function createLangfuseCollector(name: string, now: () => number = Date.now) {
  const trace: LangfuseTrace = { name, startTime: now(), observations: [] }
  const openSpans = new Map<string, Observation>()
  let generation: Observation | null = null

  const finish = (o: Observation | undefined, at: number) => {
    if (o && o.endTime === undefined) {
      o.endTime = at
      o.latencyMs = at - o.startTime
    }
  }

  const hooks: AgentHooks = {
    onEvent: (e: AgentEvent) => {
      const at = now()
      switch (e.type) {
        case 'run_start':
          trace.input = e.input
          break
        case 'step':
          finish(generation ?? undefined, at) // close the previous model call
          generation = {
            type: 'generation',
            name: `llm:step-${e.step}`,
            startTime: at,
            usage: {
              input: e.usage.inputTokens,
              output: e.usage.outputTokens,
              total: e.usage.totalTokens,
            },
          }
          trace.observations.push(generation)
          break
        case 'thinking':
          if (generation) generation.output = e.text
          break
        case 'tool_call': {
          const span: Observation = {
            type: 'span',
            name: `tool:${e.tool}`,
            startTime: at,
            input: e.args,
          }
          openSpans.set(`${e.step}:${e.tool}`, span)
          trace.observations.push(span)
          break
        }
        case 'tool_result':
          finish(openSpans.get(`${e.step}:${e.tool}`), at)
          if (openSpans.get(`${e.step}:${e.tool}`)) {
            ;(openSpans.get(`${e.step}:${e.tool}`) as Observation).output = e.result
          }
          break
        case 'output':
          if (e.final) trace.output = e.value
          break
        case 'run_end':
          finish(generation ?? undefined, at)
          trace.endTime = at
          trace.latencyMs = at - trace.startTime
          break
      }
    },
  }

  return { hooks, trace: () => trace }
}

// --- demo: an agent that calls a tool, then answers ---
const getWeather = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'Get the weather',
  execute: ({ city }) => ({ city, tempC: 32, sky: 'sunny' }),
})

let turn = 0
const model: LanguageModel = {
  id: 'mock-model',
  generate: () => {
    turn++
    return Promise.resolve(
      turn === 1
        ? {
            content: 'Checking the weather…',
            toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Bangkok' } }],
            usage: { inputTokens: 42, outputTokens: 12 },
          }
        : {
            content: 'It is 32°C and sunny in Bangkok.',
            usage: { inputTokens: 55, outputTokens: 14 },
          },
    )
  },
}

const lf = createLangfuseCollector('weather-bot')
await new Agent({ model, tools: [getWeather], hooks: lf.hooks }).run('weather in Bangkok?')

console.log(JSON.stringify(lf.trace(), null, 2))

// --- forwarding to the real Langfuse SDK (sketch) ---
//
// import { Langfuse } from 'langfuse'
// const langfuse = new Langfuse({ publicKey, secretKey, baseUrl })
// let trace, gen
// hooks = { onEvent: (e) => {
//   if (e.type === 'run_start') trace = langfuse.trace({ name: 'weather-bot', input: e.input })
//   if (e.type === 'step')      gen = trace.generation({ name: `llm:step-${e.step}`,
//                                  usageDetails: { input: e.usage.inputTokens, output: e.usage.outputTokens } })
//   if (e.type === 'thinking')  gen?.update({ output: e.text }) && gen?.end()
//   if (e.type === 'tool_call') trace.span({ name: `tool:${e.tool}`, input: e.args, id: `${e.step}:${e.tool}` })
//   if (e.type === 'tool_result') /* end that span with output: e.result */
//   if (e.type === 'output' && e.final) trace.update({ output: e.value })
//   if (e.type === 'run_end')   langfuse.flushAsync()
// }}
