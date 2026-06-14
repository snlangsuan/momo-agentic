/**
 * Persist run logs to MongoDB (Layer 1 is the host's — momo-agentic just gives
 * you the structured data). Two patterns are shown:
 *
 *   1) one document per run  — build it from `result.trace` after the run, then
 *      `insertOne`. Best for querying "what happened in this turn".
 *   2) streaming per event   — append every AgentEvent to a collection live
 *      (sketch at the bottom), for real-time dashboards / audit.
 *
 * Runs offline: without MONGODB_URI it prints the document (dry run). With it,
 * `bun add mongodb` and set MONGODB_URI to insert for real.
 *
 *   bun run examples/mongo-trace.ts
 *   MONGODB_URI=mongodb://localhost:27017 bun run examples/mongo-trace.ts
 */
import { Agent, type LanguageModel, defineTool } from '../src/index'

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

const AGENT_NAME = 'weather-bot'
const input = 'weather in Bangkok?'

// Time the run for latency (the core trace carries tokens; timing is the host's).
const startedAt = new Date()
const result = await new Agent({ name: AGENT_NAME, model, tools: [getWeather] }).run(input)
const endedAt = new Date()

// 1) Build one queryable document per run from the structured result.
const doc = {
  agent: AGENT_NAME,
  input,
  output: result.output,
  status: 'ok' as const,
  usage: result.usage, // { inputTokens, outputTokens, totalTokens }
  steps: result.trace, // [{ step, usage, text, tools: [{ name, args, result }] }]
  toolsInvoked: result.toolsInvoked,
  skillsUsed: result.skillsUsed,
  returns: result.returns,
  startedAt,
  endedAt,
  latencyMs: endedAt.getTime() - startedAt.getTime(),
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.log('[dry run — set MONGODB_URI to insert] document:')
  console.log(JSON.stringify(doc, null, 2))
} else {
  // Dynamic import so the example runs without the driver unless you use it.
  const { MongoClient } = (await import('mongodb')) as typeof import('mongodb')
  const client = new MongoClient(uri)
  try {
    await client.connect()
    const res = await client.db('agentic').collection('agent_runs').insertOne(doc)
    console.log('inserted run:', res.insertedId.toString())
  } finally {
    await client.close()
  }
}

// 2) Streaming variant — append every event to its own collection (sketch):
//
// const client = new MongoClient(uri)
// const events = client.db('agentic').collection('agent_events')
// const runId = crypto.randomUUID()
// const agent = new Agent({ name: AGENT_NAME, model, tools: [getWeather], hooks: {
//   onEvent: (e) => { void events.insertOne({ runId, at: new Date(), ...e }) },
// }})
// // then query: events.find({ runId }).sort({ at: 1 })
