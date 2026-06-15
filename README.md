# momo-agentic

A small, **provider-agnostic** TypeScript library for building **agentic bots** on
Bun and Node.js. You bring a language model and some tools; `momo-agentic` runs
the agent loop, memory, tool calling, multi-agent handoff, and observability.

Its public API is organized along the [8 architectural layers of agentic AI](https://aakashgupta.medium.com/the-8-architectural-layers-of-agentic-ai-a-complete-guide-for-product-managers-6794d75ac988).
Every layer is an **injectable port** — Infrastructure (databases, vendor SDKs)
is supplied by your app, never baked into the library.

## Documentation

- 🌐 **API site (GitHub Pages)** — an API reference, an Examples page (every example
  inline), and these guides, generated from source.
- 📖 **[Hand-written API reference → docs/API.md](docs/API.md)** — narrative reference by layer.
- 🧪 **[Examples → examples/](examples/README.md)** — a runnable example per feature.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Architecture: the 8 layers](#architecture-the-8-layers)
- [Guides](#guides)
  - [Defining tools](#defining-tools)
  - [Skills (bundling tools)](#skills-bundling-tools)
  - [Connecting a real LLM](#connecting-a-real-llm)
  - [Memory: short-term + long-term](#memory-short-term--long-term)
  - [Streaming & usage hooks](#streaming--usage-hooks)
  - [Routing with a planner](#routing-with-a-planner)
  - [External tools (MCP-style)](#external-tools-mcp-style)
  - [Multi-agent handoff](#multi-agent-handoff)
  - [Custom reasoning strategy](#custom-reasoning-strategy)
- [Examples](#examples)
- [License](#license)

---

## Features

- 🧩 **Provider-agnostic** — plug any LLM in via one `LanguageModel` port
- 🛠️ **Tools** — author with `defineTool`, the `BaseTool` class, or a plain object
- 🧰 **Skills** — bundle tools + an instruction fragment into a named capability,
  defined in code or a `skill.md` manifest
- 🔁 **Pluggable cognition** — the ReAct loop is a swappable `ReasoningStrategy`
- 🧠 **Memory (short + long term)** — conversation history + durable facts with
  semantic recall; an auto `remember_fact` tool and a `SummarizingMemory` decorator
- 🔌 **Protocol seam** — pull external tools (MCP-style) via `ToolProvider`
- 🤝 **Multi-agent** — expose any agent as a tool with `agentAsTool` (handoff)
- 📊 **Hooks** — one typed event stream for your UI (Application) and metering (Governance)
- 🛡️ **Guardrails** — in-prompt + enforced input/output checks that block or replace
- 🔒 **Human-in-the-loop** — gate sensitive tools with a `ToolApprover` (allow/deny/edit)
- 🌊 **Token streaming** + ♻️ **resilience** — `generateStream`, `withRetry`, run `timeoutMs`
- 🧾 **Structured output** — get a validated typed object via `responseSchema` + `result.object`
- 🪟 **Context budgeting** + 💸 **usage limits** — `contextLimit`/`tokenCounter`, `usageLimiter`
- 📦 **Dual ESM + CJS** output, full type definitions
- 🪶 **Zero runtime dependencies**

## Requirements

- [Bun](https://bun.sh) 1.2+ (runtime, package manager, test runner)
- Works in any Node.js ≥ 18 host once built (dual ESM + CJS output)

## Install

```bash
bun add momo-agentic
```

## Quick start

```ts
import { Agent, defineTool, type LanguageModel } from 'momo-agentic'

// 1. Define a tool (Layer 4 — Tooling)
const getWeather = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: ({ city }) => `It is sunny in ${city}.`,
})

// 2. Adapt your LLM provider to the LanguageModel port (Layer 5 — Cognition)
const model: LanguageModel = {
  id: 'my-model',
  generate: async ({ messages, tools }) => {
    // Call your provider, then map its reply to { content, toolCalls?, usage? }.
    return { content: 'Hello!' }
  },
}

// 3. Run the agent
const agent = new Agent({
  model,
  instructions: 'You are a helpful assistant.',
  tools: [getWeather],
})

const result = await agent.run('What is the weather in Bangkok?')
console.log(result.output) // final answer
console.log(result.usage)  // token totals
```

The agent loops **model ⇄ tools ⇄ model** until the model produces a final answer
or hits `maxSteps` (default 10).

The system prompt is layered by role, so you can keep each concern separate:
`persona` (voice) → `instructions` (how to operate) → skills + recalled facts →
`policy` (safety/policy). The `policy` is rendered **last**, wrapped in framing
that declares it overrides everything above and any user request:

```ts
const agent = new Agent({
  model,
  persona: 'You are Momo, a friendly support agent.',
  instructions: 'Answer concisely; prefer tools over guessing.',
  policy: 'Never share another customer’s data. Never give financial advice.',
})
```

The in-prompt `policy` *asks* the model to behave; `outputGuardrails` *enforce*
it. They are injected checks that run on the final answer before it is returned —
the first to block replaces the answer with a safe substitute (and emits a
`guardrail` event). The check can be a term scan, a regex, a moderation API, or a
second model call:

```ts
const noSecrets: OutputGuardrail = {
  name: 'no-secrets',
  check: (output) =>
    /password|api[_-]?key|token/i.test(output)
      ? { pass: false, output: 'I can’t share credentials.' }
      : { pass: true },
}

new Agent({ model, outputGuardrails: [noSecrets] }) // see examples/guardrails.ts
```

Symmetrically, `inputGuardrails` run **before** the model — the first to block
short-circuits the turn (the model is never called) and returns a refusal. Use them
to stop prompt injection, jailbreaks, or disallowed input early. The `guardrail`
event carries `stage: 'input' | 'output'`.

### Production: streaming, approval, resilience

```ts
import { Agent, withRetry, type ToolApprover } from 'momo-agentic'

// Token streaming — implement LanguageModel.generateStream in your adapter; the
// agent then emits a `token` event per delta (great for chat UIs):
agent.run(input, {}) // hooks.onEvent → { type: 'token', delta } as text arrives

// Human-in-the-loop — gate sensitive tools (flag them requiresApproval: true):
const approver: ToolApprover = {
  name: 'human',
  approve: async (req) => (await askHuman(req)) ? { decision: 'allow' } : { decision: 'deny' },
}

// Resilience — retry transient model failures, and cap the whole run:
new Agent({
  model: withRetry(model, { retries: 3 }), // backoff on rate limits / 5xx
  toolApprover: approver,
  timeoutMs: 30_000, // AgentError(stage: 'timeout') on deadline
})
```

### Structured output, context budget, usage limits

```ts
import { Agent, InMemoryUsageLimiter } from 'momo-agentic'

const agent = new Agent({
  model,
  // Typed answer: the model fills this schema; result.object is the validated value.
  responseSchema: {
    schema: {
      type: 'object',
      properties: { city: { type: 'string' }, celsius: { type: 'number' } },
      required: ['city', 'celsius'],
    },
    // parse: (d) => WeatherSchema.parse(d), // optional zod/ajv validation
  },
  contextLimit: 8000, // trim old turns to fit ~8k tokens (uses tokenCounter; default ≈4 chars/token)
  usageLimiter: new InMemoryUsageLimiter({ maxTokens: 1_000_000, key: (c) => String(c.metadata.userId) }),
})

const { object } = await agent.run('weather in Bangkok?', { metadata: { userId: 'alice' } })
// object → { city: 'Bangkok', celsius: 34 }
```

See `examples/structured-output.ts`, `examples/context-budgeting.ts`, `examples/rate-limit.ts`.

## Core concepts

| Concept | What it is |
| --- | --- |
| **Agent** | The orchestrator. Assembles the prompt from memory + instructions, runs the reasoning strategy, persists the turn, and emits events. Thin by design. |
| **LanguageModel** | The one port you must implement: turn a transcript + tool schemas into one completion step. Bridges any vendor SDK. |
| **Tool** | A capability the model can call. Plain JSON-Schema parameters (MCP/OpenAI/Gemini-compatible) + an `execute` function. |
| **ReasoningStrategy** | The decision loop. The default `ReActStrategy` does reason → act → observe → repeat. Swappable. |
| **Memory** | Short-term conversation + optional long-term facts. Injected; defaults to in-process. |
| **Planner** | Optional pre-step that routes a turn or narrows the toolset. |
| **AgentHooks** | A typed event stream for UI streaming and governance/metering. |

## Architecture: the 8 layers

Each `src/` folder maps to one layer. Infrastructure (Layer 1) lives in **your**
app and is injected through these ports.

| Layer | Folder | Ports / primitives |
| --- | --- | --- |
| 2 Agent Internet | `network/` | `agentAsTool` |
| 3 Protocol | `protocol/` | `ToolProvider`, `defineToolProvider`, `collectProviderTools` |
| 4 Tooling | `tooling/` | `Tool`, `BaseTool`, `defineTool`, `ToolRegistry`, `ToolApprover` |
| 4 Tooling (Skills) | `skill/` | `Skill`, `defineSkill`, `BaseSkill`, `SkillRegistry`, `defineSkillFromManifest` |
| 5 Cognition | `cognition/` | `LanguageModel`, `Planner`, `ReasoningStrategy`, `ReActStrategy`, `PlanAndExecuteStrategy`, `withRetry` |
| 6 Memory | `memory/` | `Memory`, `InMemoryMemory`, `SummarizingMemory`, `MemoryStore`, `createRememberTool`, `TokenCounter` |
| 7 + 8 App / Governance | `observability/` | `AgentHooks`, `AgentEvent`, `UsageTracker`, `combineHooks`, `OutputGuardrail`, `InputGuardrail`, `UsageLimiter` |
| — orchestrator | `agent/` | `Agent`, `BaseAgent`, `IAgent` |

---

## Guides

### Defining tools

Three equivalent ways — pick by ceremony level:

```ts
import { defineTool, BaseTool, type Tool } from 'momo-agentic'

// (a) functional helper — typed args
const add = defineTool<{ a: number; b: number }>({
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: ({ a, b }) => a + b, // non-string returns are JSON-serialized
})

// (b) prototype class — for stateful tools / dependency injection
class Search extends BaseTool<{ q: string }> {
  readonly name = 'search'
  readonly description = 'Search the web'
  readonly parameters = {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  }
  constructor(private readonly client: MyClient) {
    super()
  }
  execute({ q }: { q: string }) {
    return this.client.search(q)
  }
}

// (c) plain object — full control / adapters
const ping: Tool = {
  name: 'ping',
  description: 'ping',
  parameters: { type: 'object', properties: {} },
  execute: () => 'pong',
}
```

Set `directReturn: true` on a tool to make its result the final answer (the loop
exits without another model pass). The tool should return `{ message: string }`
or a plain string.

### Skills (bundling tools)

A **Skill** is a named bundle of tools plus an instruction fragment. When you give
an agent a skill, it exposes all the skill's tools **and** injects the skill's
instruction into the system prompt. `result.skillsUsed` reports which skills were
actually used — handy for metering/governance.

```ts
import { Agent, defineSkill, defineSkillFromManifest, defineTool } from 'momo-agentic'

// In code:
const weather = defineSkill({
  name: 'weather',
  description: 'Current weather lookups',
  instruction: 'For weather questions, call get_weather and report °C.',
  tools: [getWeather],
  keywords: ['weather', 'forecast'], // optional, for routers
  creditCost: 2,                     // optional, for governance
})

// Or from a `skill.md` manifest (prose/metadata outside code):
const md = `---
name: web_search
description: Search the web
credit_cost: 3
keywords: [search, news]
---
Use the search tool for anything current. Cite sources.`
const search = defineSkillFromManifest(md, [searchTool])

const agent = new Agent({ model, skills: [weather, search] })
const result = await agent.run('weather in Bangkok?')
console.log(result.skillsUsed) // → ['weather']
```

In Bun you can import a manifest file directly:
`import md from './skill.md' with { type: 'text' }`. See [examples/skills.ts](examples/skills.ts).

### Connecting a real LLM

Implement `LanguageModel` once. Map your provider's tool-call format to the
neutral `ToolCall` shape, and report `usage` if available.

```ts
import type { LanguageModel } from 'momo-agentic'

export function claudeModel(client: MyAnthropicClient, modelId: string): LanguageModel {
  return {
    id: modelId,
    generate: async ({ messages, tools, signal }) => {
      const res = await client.messages.create(
        {
          model: modelId,
          messages: toProviderMessages(messages),
          tools: tools.map(toProviderTool),
        },
        { signal },
      )
      return {
        content: extractText(res),
        toolCalls: extractToolCalls(res), // [{ id, name, arguments }]
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      }
    },
  }
}
```

> Building an AI app? Default to the latest Claude models (e.g. `claude-opus-4-8`).

### Memory: short-term + long-term

```ts
import { Agent, InMemoryMemory, SummarizingMemory } from 'momo-agentic'

const store = new InMemoryMemory() // conversation (short) + facts (long)

// Optional: bound short-term growth by summarizing old turns.
const memory = new SummarizingMemory(store, {
  summarizer: { summarize: (msgs) => myLLMSummary(msgs) },
  threshold: 40,
  keepRecent: 20,
})

const agent = new Agent({
  model,
  memory,
  rememberFacts: true, // auto-add a `remember_fact` tool so the model writes facts
  factRecallLimit: 8,  // cap facts injected per turn
})
```

- **Short-term**: `loadHistory` / `appendMessage` — the running transcript.
- **Long-term**: `rememberFact` / `recallFacts` / optional `searchFacts` — durable facts.
- On each turn, facts are recalled into the system prompt. If the whole fact set
  fits within `factRecallLimit`, all are injected (so identity facts like a name
  are never dropped); beyond that, `searchFacts` ranks by relevance to the input.
- Back it with Redis / Postgres / a vector SDK by implementing `Memory`; add
  `searchFacts` for true semantic recall.

**Multi-user / multi-thread.** To serve many users — each with many threads — from
one base agent, hand out a scoped memory with `MemoryStore`: conversation is
isolated per `(userId, threadId)`, while long-term facts are shared per `userId`
across that user's threads. `agent.withMemory(...)` forks a thin agent bound to a
scope (the agent is stateless, so this is cheap):

```ts
import { Agent, MemoryStore } from 'momo-agentic'

const store = new MemoryStore() // defaults to InMemoryMemory per tier
const base = new Agent({ model, tools })
const agentFor = (userId: string, threadId: string) =>
  base.withMemory(store.for({ userId, threadId }))

await agentFor('alice', 'work').run('book a meeting')   // isolated thread
await agentFor('alice', 'travel').run('find flights')   // shares alice's facts
```

Pass custom per-tier backends via `MemoryStoreOptions` (`conversation`, `facts`;
`facts: null` for conversation-only). See `examples/multi-user.ts`.

### Streaming & usage hooks

One event stream powers both your UI (Application, Layer 7) and metering
(Governance, Layer 8).

```ts
import { Agent, UsageTracker, combineHooks } from 'momo-agentic'

const tracker = new UsageTracker()

const agent = new Agent({
  model,
  hooks: combineHooks(
    { onEvent: (e) => {
        if (e.type === 'thinking') ui.appendThought(e.text)
        if (e.type === 'tool_call') ui.showToolBadge(e.tool)
        if (e.type === 'run_end') ui.finalize(e.output)
      } },
    tracker.hooks, // governance: tallies tokens + tool calls
  ),
})

await agent.run('…')
console.log(tracker.snapshot()) // { runs, usage, toolCalls }
```

Event types: `run_start`, `plan`, `thinking`, `tool_call`, `tool_result`,
`message`, `usage`, `error`, `run_end`. See [docs/API.md](docs/API.md).

### Routing with a planner

A `Planner` runs before the loop to answer directly or narrow the toolset.

```ts
import type { Planner } from 'momo-agentic'

const planner: Planner = {
  name: 'router',
  plan: (input) =>
    input.includes('weather')
      ? { mode: 'use_tools', tools: ['get_weather'], reason: 'weather intent' }
      : { mode: 'respond' }, // expose no tools — answer directly
}

const agent = new Agent({ model, tools: [getWeather], planner })
```

### External tools (MCP-style)

Bring tools from an external source by implementing `ToolProvider`. Because tool
parameters are plain JSON Schema, an MCP adapter just maps the remote list.

```ts
import { Agent, defineToolProvider } from 'momo-agentic'

const provider = defineToolProvider('my-mcp', async () => {
  const remote = await mcpClient.listTools()
  return remote.map(toMomoTool) // map each to a Tool whose execute calls the server
})

const agent = new Agent({ model, toolProviders: [provider] })
```

### Multi-agent handoff

Expose any agent as a tool another agent can delegate to — no special routing.

```ts
import { Agent, agentAsTool } from 'momo-agentic'

const researcher = new Agent({ name: 'researcher', model, tools: [webSearch] })

const lead = new Agent({
  name: 'lead',
  model,
  tools: [agentAsTool(researcher, { description: 'Delegate web research tasks' })],
})

await lead.run('What is the capital of Thailand?')
```

Any `Agent` (or subclass of `BaseAgent`) also has `.asTool({ description })`.

### Custom reasoning strategy

Replace the default ReAct loop by implementing `ReasoningStrategy` and passing it
as `strategy`. A second strategy ships built in: `PlanAndExecuteStrategy` plans the
whole turn up front, executes each step (each its own ReAct loop), then synthesizes
the answer — and with `{ replan: true }` it revises the remaining steps after each
step as results come in. Use it via
`new Agent({ model, strategy: new PlanAndExecuteStrategy() })` (see
`examples/plan-and-execute.ts`). For a fully bespoke orchestration, extend
`BaseAgent` instead.

```ts
import { Agent, type ReasoningStrategy } from 'momo-agentic'

const myStrategy: ReasoningStrategy = {
  name: 'my-loop',
  run: async (input) => {
    /* drive input.model / input.tools / input.messages yourself */
    return { output: '…', messages: input.messages, steps: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolsInvoked: [] }
  },
}

const agent = new Agent({ model, strategy: myStrategy })
```

---

## Examples

A runnable example for every feature lives in **[examples/](examples/README.md)**
(with a feature → example map). All but `ai-assistant/` use a mock model, so they
run with no API key:

```bash
bun run examples/basic.ts            # tool + memory + hooks
bun run examples/tools.ts            # tool styles, directReturn, ToolRegistry
bun run examples/tool-approval.ts    # human-in-the-loop tool approval (allow/deny/edit)
bun run examples/tool-internal-llm.ts # directReturn tool that calls an LLM internally
bun run examples/skills.ts           # bundle tools into skills (code + manifest)
bun run examples/planner.ts          # route a turn (respond/auto/use_tools)
bun run examples/custom-strategy.ts  # swap the ReAct loop
bun run examples/custom-agent.ts     # extend BaseAgent
bun run examples/tool-provider.ts    # external tools (ToolProvider)
bun run examples/memory.ts           # short-term + long-term memory
bun run examples/custom-memory.ts    # your own Memory backend + searchFacts
bun run examples/summarizing-memory.ts # fold old turns into a summary (threshold/keepRecent)
bun run examples/multi-user.ts       # scope memory per (userId, threadId)
bun run examples/context-budgeting.ts # trim old turns to a token budget (contextLimit)
bun run examples/structured-output.ts # validated typed object via responseSchema
bun run examples/observability.ts    # every event + UsageTracker
bun run examples/streaming-tokens.ts # token-by-token streaming (generateStream)
bun run examples/guardrails.ts       # in-prompt + enforced input/output guardrails
bun run examples/rate-limit.ts       # per-user run/token budgets (usageLimiter)
bun run examples/resilience.ts       # withRetry + per-run timeoutMs
bun run examples/multi-agent.ts      # delegate to a specialist agent
bun run examples/errors-and-abort.ts # AgentError, AbortSignal, maxSteps
bun run examples/skill-manifest/index.ts  # load a skill from a skill.md file
```

**Real-world assistant** — [examples/ai-assistant/](examples/ai-assistant/README.md):
a Gemini 3.0 (`@google/genai`) assistant with two MCP tool servers — **searxng**
for web search and an **LLM-wiki** knowledge base — plus memory, streaming, and
usage metering. Shows how to write a `LanguageModel` adapter and an MCP
`ToolProvider`. Run it after setting `GEMINI_API_KEY` and your MCP server env:

```bash
bun run examples/ai-assistant/run.ts "What changed in RAG this year?"
```

## Contributing

Building on the library (dev setup, tests, docs, releasing, publishing) is
covered in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## License

MIT — see [LICENSE](LICENSE).
