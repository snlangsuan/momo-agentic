// In your app this is:  import { createOpenAIModel } from 'momo-agentic/openai'
import { createOpenAIModel } from '../src/adapters/openai'
/**
 * Built-in LLM adapters (Layer 5 — Cognition).
 *
 * momo-agentic ships ready-made `LanguageModel`s behind separate entry points,
 * so the core stays dependency-free — install only the SDK you import:
 *
 *   import { createGeminiModel } from 'momo-agentic/gemini'   // needs @google/genai
 *   import { createOpenAIModel } from 'momo-agentic/openai'   // needs openai
 *
 *   // Google Gemini — Developer API…
 *   const gemini = createGeminiModel({ apiKey: process.env.GEMINI_API_KEY! })
 *   // …or Vertex AI (ADC auth), same adapter:
 *   const vertex = createGeminiModel({ vertexai: true, project: 'my-proj', location: 'us-central1' })
 *   // OpenAI…
 *   const openai = createOpenAIModel({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' })
 *   // …or any OpenAI-compatible host via baseURL (Groq, Together, OpenRouter, Ollama, vLLM…):
 *   const local = createOpenAIModel({ baseURL: 'http://localhost:11434/v1', model: 'llama3.1' })
 *
 *   new Agent({ model: gemini })   // or openai, vertex, local
 *
 * To make THIS file runnable with no API key and no external network, it spins
 * up a tiny local server that speaks the OpenAI Chat Completions wire format and
 * points `createOpenAIModel` at it — driving a full Agent turn (tool call +
 * streaming) through the real adapter + SDK.
 *
 * Run with:  bun run examples/adapters.ts
 */
import { Agent, defineTool } from '../src/index'

// --- A throwaway OpenAI-compatible server (stands in for a real provider) ----
function sse(events: unknown[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const reqBody = (await req.json()) as { messages: Array<{ role: string }> }
    const toolHasRun = reqBody.messages.some((m) => m.role === 'tool')

    // Turn 1: ask to call the tool. Turn 2 (tool result present): stream the answer.
    if (!toolHasRun) {
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_time', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Bangkok"}' } }] },
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        },
      ])
    }

    const words = 'It is 09:00 in Bangkok right now.'.split(' ')
    const events: unknown[] = words.map((w, i) => ({
      choices: [{ delta: { content: i === 0 ? w : ` ${w}` } }],
    }))
    events.push({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 9 },
    })
    return sse(events)
  },
})

// --- Wire the adapter into an Agent ----------------------------------------
const model = createOpenAIModel({
  baseURL: `http://localhost:${server.port}/v1`,
  apiKey: 'not-needed-for-local',
  model: 'demo-model',
})

const getTime = defineTool<{ city: string }>({
  name: 'get_time',
  description: 'Get the current local time for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: ({ city }) => ({ city, time: '09:00' }),
})

const agent = new Agent({
  model,
  instructions: 'Answer the time question using the get_time tool.',
  tools: [getTime],
  hooks: {
    onEvent: (e) => {
      if (e.type === 'tool_call') console.log(`  🔧 ${e.tool}(${JSON.stringify(e.args)})`)
      if (e.type === 'token') process.stdout.write(e.delta) // live streamed tokens
    },
  },
})

console.log(`🌐 local OpenAI-compatible server on :${server.port}\n`)
console.log('❓ What time is it in Bangkok?\n')
process.stdout.write('🤖 ')
const result = await agent.run('What time is it in Bangkok?')
console.log(`\n\n✅ final: ${result.output}`)
console.log('📊 usage:', result.usage, '| tools:', result.toolsInvoked)

await server.stop()
