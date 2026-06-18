# momo-agentic — API Reference

Complete reference for every public export, organized by architectural layer.
All exports are available from the package root:

```ts
import { Agent, defineTool, InMemoryMemory /* … */ } from 'momo-agentic'
```

- New here? Start with the **[README](../README.md)**.

## Contents

- [Shared primitives](#shared-primitives)
- [Agent (orchestrator)](#agent-orchestrator)
- [Layer 2 — Agent Internet](#layer-2--agent-internet)
- [Layer 3 — Protocol](#layer-3--protocol)
- [Layer 4 — Tooling](#layer-4--tooling)
- [Layer 5 — Cognition](#layer-5--cognition)
- [Layer 6 — Memory](#layer-6--memory)
- [Layers 7 + 8 — Observability](#layers-7--8--observability)

---

## Shared primitives

Layer-neutral types used everywhere.

### `Role`

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool'
```

### `Message`

A single entry in a conversation transcript.

```ts
interface Message {
  role: Role
  content: string            // text; may be '' (or the text fallback for parts)
  parts?: ContentPart[]       // multimodal parts (image/audio/video/file + text)
  toolCalls?: ToolCall[]      // present on assistant messages that call tools
  toolCallId?: string         // links a tool-result message to its ToolCall
  name?: string               // tool name on a tool-result message
}
```

### Multimodal input — `RunInput`, `ContentPart`, `MediaSource`

`agent.run` accepts plain text **or** a list of parts. With parts, the user
message carries them on `parts`; `content` holds a text-only fallback (used by
memory, planner, and fact search). Your `LanguageModel` adapter forwards `parts`
to the provider — see how the Gemini adapter maps them in
[examples/ai-assistant/gemini-model.ts](../examples/ai-assistant/gemini-model.ts).

```ts
type RunInput = string | ContentPart[]

type ContentPart =
  | { type: 'text';  text: string }
  | { type: 'image'; source: MediaSource }
  | { type: 'audio'; source: MediaSource }
  | { type: 'video'; source: MediaSource }
  | { type: 'file';  source: MediaSource; name?: string }

interface MediaSource {
  url?: string        // remote URL
  data?: string       // OR inline base64 (no data: prefix)
  mimeType?: string   // e.g. 'image/png', 'audio/mpeg', 'video/mp4'
}

// partsToText(parts): concatenate the text parts (media ignored)
await agent.run([
  { type: 'text', text: 'What is in this image?' },
  { type: 'image', source: { url: 'https://…/cat.png', mimeType: 'image/png' } },
])
```

> **Streaming over WebSocket (“ws”)** is a transport concern, not the core: pipe
> the hook events to a socket (`hooks: { onEvent: (e) => ws.send(JSON.stringify(e)) }`)
> to stream `step` / `tool_*` / `output` to a client. For live audio/video input,
> accept `audio`/`video` parts as above.

### `ToolCall`

A model's request to invoke a tool.

```ts
interface ToolCall {
  id: string                          // correlates the call with its result
  name: string                        // must match a registered tool
  arguments: Record<string, unknown>  // parsed arguments
}
```

### `ToolSchema`

Provider-neutral tool description (JSON Schema — MCP/OpenAI/Gemini compatible).

```ts
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}
```

### `Usage`

Token accounting, summed across reasoning steps.

```ts
interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}
```

### `emptyUsage()` / `addUsage()`

```ts
function emptyUsage(): Usage
function addUsage(target: Usage, delta?: Partial<Usage>): Usage // mutates & returns target
```

`addUsage` infers `totalTokens` from `inputTokens + outputTokens` when `delta.totalTokens` is omitted.

---

## Agent (orchestrator)

### `class Agent`

The default agent. A thin orchestrator that assembles the prompt (persona +
instructions + recalled facts + history), runs a `ReasoningStrategy`, persists
the turn to memory, and emits events. Extends [`BaseAgent`](#class-baseagent).

```ts
class Agent extends BaseAgent {
  constructor(config: AgentConfig)
  readonly name: string
  run(input: string, options?: RunOptions): Promise<RunResult>
  asTool(options: AgentAsToolOptions): Tool   // inherited from BaseAgent
}
```

**Example**

```ts
const agent = new Agent({ model, instructions: 'Be helpful.', tools: [getWeather] })
const result = await agent.run('weather in Bangkok?')
```

### `AgentConfig`

```ts
interface AgentConfig {
  model: LanguageModel          // required — the LLM driving reasoning (Layer 5)
  name?: string                 // identifier in events / when used as a tool. Default 'agent'
  instructions?: string         // static system rules, prepended every run
  persona?: string              // voice/personality, prepended ahead of instructions
  tools?: Tool[]                // locally-registered tools (Layer 4)
  skills?: Skill[]              // named tool bundles + instruction fragments (Layer 4)
  toolProviders?: ToolProvider[]// external tool sources resolved at run time (Layer 3)
  streamDirectReturns?: boolean // stream directReturn results as `output` events; default false
  planner?: Planner             // optional routing / tool-narrowing (Layer 5)
  strategy?: ReasoningStrategy  // reasoning algorithm. Default: new ReActStrategy()
  memory?: Memory               // memory backend. Default: new InMemoryMemory()
  rememberFacts?: boolean       // auto-add a `remember_fact` tool. Default false
  factRecallLimit?: number      // max facts injected per turn. Default 8
  hooks?: AgentHooks            // event hooks (Layers 7 + 8)
  maxSteps?: number             // hard cap on loop iterations. Default 10
}
```

Notes:
- `rememberFacts: true` requires a memory backend exposing `rememberFact`.
- When the full fact set is ≤ `factRecallLimit`, all facts are injected; beyond
  that, the backend's `searchFacts` ranks by relevance to the input.

### `RunOptions`

```ts
interface RunOptions {
  signal?: AbortSignal                  // propagated to model + tools
  metadata?: Record<string, unknown>    // merged into each ToolContext.metadata
}
```

### `RunResult`

```ts
interface RunResult {
  output: string          // final assistant text (directReturn messages joined for display)
  returns: unknown[]      // raw directReturn tool values, in call order (objects preserved); [] if none
  trace: StepTrace[]      // per-loop breakdown: tokens, text, tools + return values
  messages: Message[]     // full working transcript (incl. tool calls/results)
  steps: number           // loop iterations performed
  usage: Usage            // token totals
  toolsInvoked: string[]  // tool names in call order (with repeats)
  skillsUsed: string[]    // deduped skills whose tools were invoked
}

interface StepTrace {
  step: number
  usage: Usage            // this loop's model-call tokens
  text?: string           // assistant text this loop (reasoning, or final answer)
  tools: ToolTrace[]      // tools run this loop, in call order
}

interface ToolTrace {
  name: string
  args: Record<string, unknown>
  result: unknown         // raw return value (objects preserved)
}
```

For structured output, give the tool `directReturn: true` and read `result.returns`
(objects are preserved); `output` is the text rendering. With multiple directReturn
tools, `returns` holds each value in call order.

```ts
const result = await agent.run('show balance')
result.returns[0] // → { type: 'balance_card', balance: 1234 }  (the raw object)
result.output // → text fallback for display
```

### `interface IAgent`

The agent contract. Anything implementing it can be composed and exposed as a tool.

```ts
interface IAgent {
  readonly name: string
  run(input: string, options?: RunOptions): Promise<RunResult>
}
```

### `abstract class BaseAgent`

Prototype base class for **custom** agents. Extend it to write a bespoke
orchestration while staying composable; subclasses get `asTool()` for free.

```ts
abstract class BaseAgent implements IAgent {
  abstract readonly name: string
  abstract run(input: string, options?: RunOptions): Promise<RunResult>
  asTool(options: AgentAsToolOptions): Tool
}
```

### `class AgentError`

Thrown when a run fails, tagged with the failing stage.

```ts
class AgentError extends Error {
  readonly stage: string   // e.g. 'run'
  // cause is attached when available
}
```

---

## Layer 2 — Agent Internet

Multi-agent composition: an agent is also a tool.

### `agentAsTool()`

Wrap an agent as a `Tool` another agent can delegate to via normal function calling.

```ts
function agentAsTool(agent: IAgent, options: AgentAsToolOptions): Tool
```

### `AgentAsToolOptions`

```ts
interface AgentAsToolOptions {
  description: string    // required — tells the caller when to delegate here
  name?: string          // tool name. Default: the agent's name
  inputName?: string     // name of the single string input. Default 'input'
}
```

**Example**

```ts
const lead = new Agent({
  name: 'lead',
  model,
  tools: [agentAsTool(researcher, { description: 'Delegate research questions' })],
})
```

---

## Layer 3 — Protocol

Import tools from external sources (MCP, A2A, HTTP registries).

### `interface ToolProvider`

```ts
interface ToolProvider {
  readonly name: string
  listTools(): Promise<Tool[]> | Tool[]   // discover & return tools
  close?(): Promise<void> | void          // optional teardown
}
```

### `defineToolProvider()`

Build a provider from a static list or a loader function.

```ts
function defineToolProvider(
  name: string,
  source: Tool[] | (() => Promise<Tool[]> | Tool[]),
  close?: () => Promise<void> | void,
): ToolProvider
```

### `collectProviderTools()`

Resolve tools from several providers concurrently into one flat list.

```ts
function collectProviderTools(providers: ToolProvider[]): Promise<Tool[]>
```

---

## Layer 4 — Tooling

The agent's callable capabilities.

### `interface Tool`

```ts
interface Tool<TArgs = Record<string, unknown>> extends ToolSchema {
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
  directReturn?: boolean   // if true, the result becomes the final answer (loop exits)
}
```

A non-string `execute` return is JSON-serialized before being fed back to the
model. For `directReturn`, return `{ message: string }` or a plain string.

### `interface ToolContext`

Passed to every `execute` call.

```ts
interface ToolContext {
  agentName: string                   // the invoking agent
  signal?: AbortSignal                // propagated from the run
  metadata: Record<string, unknown>   // per-run data from RunOptions.metadata
}
```

### `defineTool()`

Typed functional helper.

```ts
function defineTool<TArgs = Record<string, unknown>>(definition: ToolDefinition<TArgs>): Tool<TArgs>

interface ToolDefinition<TArgs> {
  name: string
  description: string
  parameters?: Record<string, unknown>   // JSON Schema. Default: empty object schema
  directReturn?: boolean
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
}
```

### `abstract class BaseTool`

Prototype class for stateful tools / dependency injection.

```ts
abstract class BaseTool<TArgs = Record<string, unknown>> implements Tool<TArgs> {
  abstract readonly name: string
  abstract readonly description: string
  readonly parameters: Record<string, unknown>   // default: { type: 'object', properties: {} }
  readonly directReturn?: boolean
  abstract execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
}
```

### `toToolSchema()`

Extract the provider-neutral schema from a tool.

```ts
function toToolSchema(tool: Tool): ToolSchema
```

### `class ToolRegistry`

Name-keyed tool collection; last registration of a name wins.

```ts
class ToolRegistry {
  register(...tools: Tool[]): this
  get(name: string): Tool | undefined
  has(name: string): boolean
  list(): Tool[]            // insertion order
  readonly size: number
}
```

### Skills

A **Skill** bundles tools with an instruction fragment and metadata. Passing
`skills` to an `Agent` exposes every skill's tools and injects each skill's
`instruction` into the system prompt; `RunResult.skillsUsed` reports which were used.

#### `interface Skill`

```ts
interface Skill {
  name: string
  description: string
  instruction: string      // injected into the system prompt while available
  tools: Tool[]
  keywords?: string[]      // hints for a Planner/router
  creditCost?: number      // overhead for governance/metering
  allowDirectInvoke?: boolean  // default true
}
```

#### `defineSkill()`

```ts
function defineSkill(definition: SkillDefinition): Skill
// SkillDefinition has the same fields as Skill.
```

#### `abstract class BaseSkill`

Prototype class for stateful skills; supply `tools` from the subclass.

```ts
abstract class BaseSkill implements Skill {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly instruction: string
  abstract readonly tools: Tool[]
  readonly keywords?: string[]
  readonly creditCost?: number
  readonly allowDirectInvoke?: boolean
}
```

#### `class SkillRegistry`

```ts
class SkillRegistry {
  register(...skills: Skill[]): this
  get(name: string): Skill | undefined
  has(name: string): boolean
  list(): Skill[]      // insertion order
  tools(): Tool[]      // every tool across all skills, flattened
  readonly size: number
}
```

#### `parseSkillManifest()` / `defineSkillFromManifest()`

Load a skill from a `skill.md` Markdown manifest with frontmatter. Pure (text in,
no filesystem) — read the file however your runtime prefers.

```ts
function parseSkillManifest(raw: string): SkillManifest
function defineSkillFromManifest(raw: string, tools: Tool[]): Skill

interface SkillManifest {
  name: string            // required (frontmatter `name`)
  description: string     // frontmatter `description`
  instruction: string     // the manifest body
  keywords: string[]      // frontmatter `keywords: [a, b]`
  creditCost: number      // frontmatter `credit_cost`. Default 0
  allowDirectInvoke: boolean // frontmatter `allow_direct_invoke`. Default true
}
```

```ts
// Bun: import the manifest as text, then attach tools.
import md from './skill.md' with { type: 'text' }
const skill = defineSkillFromManifest(md, [searchTool])
```

---

## Layer 5 — Cognition

The reasoning core: the model port, optional planner, and the swappable loop.

### `interface LanguageModel`

The single LLM integration point. Implement once per provider.

```ts
interface LanguageModel {
  readonly id: string
  generate(options: GenerateOptions): Promise<ModelResponse>
}

interface GenerateOptions {
  messages: Message[]
  tools: ToolSchema[]
  signal?: AbortSignal
}

interface ModelResponse {
  content: string
  toolCalls?: ToolCall[]
  usage?: Partial<Usage>
}
```

### `interface Planner`

Optional pre-loop routing / tool narrowing.

```ts
interface Planner {
  readonly name: string
  plan(input: string, context: PlanContext): Promise<Plan> | Plan
}

interface PlanContext {
  agentName: string
  history: Message[]
  availableTools: string[]   // names of all currently-available tools
  signal?: AbortSignal
}

interface Plan {
  mode: 'respond' | 'auto' | 'use_tools'
  tools?: string[]   // tool names to expose when mode === 'use_tools'
  reason?: string    // optional rationale (surfaced via the 'plan' event)
}
```

- `respond` → expose no tools, answer directly.
- `auto` → expose the full toolset; the model decides.
- `use_tools` → expose only `tools`.

### `interface ReasoningStrategy`

The decision loop. Swap to change the reasoning algorithm.

```ts
interface ReasoningStrategy {
  readonly name: string
  run(input: ReasoningInput): Promise<ReasoningResult>
}

interface ReasoningInput {
  agentName: string
  model: LanguageModel
  tools: Tool[]
  messages: Message[]        // working transcript; the strategy appends to it
  maxSteps: number
  toolContext: ToolContext
  hooks?: AgentHooks
  signal?: AbortSignal
}

interface ReasoningResult {
  output: string
  messages: Message[]
  steps: number
  usage: Usage
  toolsInvoked: string[]
}
```

### `class ReActStrategy`

The default strategy: reason → act (tool calls) → observe → repeat, bounded by
`maxSteps`. Within a step, **all tool calls run concurrently**, with results
recorded in the original call order. A `directReturn` tool short-circuits the
turn — multiple directReturn messages are joined in call order, and a mix of
directReturn + normal tools still returns the directReturn answer. Includes an
immediate-repeat tool guard (anti-tight-loop) and per-tool error capture.

```ts
class ReActStrategy implements ReasoningStrategy {
  readonly name: 'react'
  run(input: ReasoningInput): Promise<ReasoningResult>
}
```

---

## Layer 6 — Memory

Short-term conversation + optional long-term facts.

### `interface Memory`

```ts
interface Memory extends ConversationMemory, Partial<FactMemory> {}
```

Conversation methods are required; fact methods are optional.

### `interface ConversationMemory` (short-term)

```ts
interface ConversationMemory {
  loadHistory(options?: LoadHistoryOptions): Promise<Message[]> | Message[]  // oldest → newest
  appendMessage(message: Message): Promise<void> | void
}

interface LoadHistoryOptions {
  limit?: number   // cap on recent messages returned
}
```

### `interface FactMemory` (long-term)

```ts
interface FactMemory {
  rememberFact(key: string, value: string): Promise<void> | void
  recallFacts(): Promise<Record<string, string>> | Record<string, string>
  searchFacts?(query: string, options?: { limit?: number }): Promise<MemoryFact[]> | MemoryFact[]
}

interface MemoryFact {
  key: string
  value: string
  score?: number   // relevance in [0,1] when from searchFacts
}
```

Implement `searchFacts` for semantic/vector recall; omit it to fall back to
`recallFacts`.

### `class InMemoryMemory`

Default zero-dependency backend (process memory). Implements both tiers,
including a keyword-overlap `searchFacts`. Good for tests and single-process bots.

```ts
class InMemoryMemory implements Memory {
  constructor(seed?: { messages?: Message[]; facts?: Record<string, string> })
  loadHistory(options?: LoadHistoryOptions): Message[]
  appendMessage(message: Message): void
  rememberFact(key: string, value: string): void
  recallFacts(): Record<string, string>
  searchFacts(query: string, options?: { limit?: number }): MemoryFact[]
}
```

### `createRememberTool()`

A tool that writes a durable fact into a memory backend — closing the long-term
loop (the `Agent` auto-registers this when `rememberFacts: true`).

```ts
function createRememberTool(
  memory: Pick<FactMemory, 'rememberFact'>,
  options?: RememberToolOptions,
): Tool

interface RememberToolOptions {
  name?: string         // default 'remember_fact'
  description?: string  // override (e.g. to localize)
}
```

### `class SummarizingMemory`

A `Memory` decorator that bounds short-term growth: once the transcript exceeds
`threshold`, older messages are compressed into one summary while `keepRecent`
recent ones stay verbatim. Long-term fact methods delegate to the inner store.

```ts
class SummarizingMemory implements Memory {
  constructor(inner: Memory, options: SummarizingMemoryOptions)
}

interface SummarizingMemoryOptions {
  summarizer: Summarizer
  threshold?: number    // summarize when total messages exceed this. Default 40
  keepRecent?: number   // recent messages kept verbatim. Default 20
}

interface Summarizer {
  summarize(messages: Message[], previousSummary?: string): Promise<string> | string
}
```

The summary is cached and only recomputed when the older-message count changes.

### `createModelSummarizer()`

Builds a `Summarizer` from any `LanguageModel`, so a `SummarizingMemory` can be
wired up without hand-writing a summarize loop. Provider-agnostic: it only calls
the injected model port and uses no tools.

```ts
function createModelSummarizer(
  model: LanguageModel,
  options?: ModelSummarizerOptions,
): Summarizer

interface ModelSummarizerOptions {
  instruction?: string   // system prompt steering the summary
  maxWords?: number      // soft length cap surfaced to the model. Default 200
}

const memory = new SummarizingMemory(new InMemoryMemory(), {
  summarizer: createModelSummarizer(model),
})
```

### `recallRelevantFacts()` / `formatFacts()`

Reusable long-term-fact helpers — the same logic the built-in `Agent` uses to
pick and render facts, exposed for custom agents and tools.

`recallRelevantFacts` returns the whole fact set when it fits within `limit`
(so always-relevant facts like the user's name are never dropped) and otherwise
falls back to the backend's semantic `searchFacts`. `formatFacts` renders a
`MemoryFact[]` or a raw `key→value` map as a `- key: value` bullet list (or `''`
when empty).

```ts
function recallRelevantFacts(
  memory: FactSource,            // Partial<Pick<FactMemory, 'recallFacts' | 'searchFacts'>>
  query: string,
  options?: { limit?: number }, // RecallOptions — default 8
): Promise<MemoryFact[]>

function formatFacts(facts: MemoryFact[] | Record<string, string>): string

const facts = await recallRelevantFacts(memory, userInput, { limit: 5 })
systemPrompt += `\n\nKnown facts about the user:\n${formatFacts(facts)}`
```

---

## Layers 7 + 8 — Observability

One typed event stream for the Application (UI) and Governance (monitoring/metering).

### `type AgentEvent`

```ts
type AgentEvent =
  | { type: 'run_start';   agent: string; input: string }
  | { type: 'plan';        agent: string; mode: string; tools?: string[]; reason?: string }
  | { type: 'thinking';    agent: string; text: string }
  | { type: 'step';        agent: string; step: number; usage: Usage }
  | { type: 'tool_call';   agent: string; step: number; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; agent: string; step: number; tool: string; result: unknown }
  | { type: 'message';     agent: string; message: Message }
  | { type: 'output';      agent: string; value: unknown; final: boolean }
  | { type: 'usage';       agent: string; usage: Usage; tools: string[]; skills: string[] }
  | { type: 'error';       agent: string; stage: string; error: Error }
  | { type: 'run_end';     agent: string; output: string; usage: Usage }
```

Per loop, a `step` event reports that iteration's token usage; `tool_call` and
`tool_result` carry the `step` they ran in, the tool name, args, and return value
— so you can attribute tokens, tools, and returns to each loop. (The `usage` event
at the end carries the turn total.)

These events map cleanly onto tracing tools like **Langfuse** — `run` → trace,
each `step` (model call) → generation (with token usage), each tool → span
(input/output). See [examples/langfuse-trace.ts](../examples/langfuse-trace.ts).

The `output` event streams results as they are produced — you don't have to wait
for the return value. `tool_result` fires the moment each tool completes (the raw
value, objects preserved). With `AgentConfig.streamDirectReturns`, each
`directReturn` tool emits `output` with `final: false` and the loop continues; the
turn's final answer is `output` with `final: true` (and `run_end` is the terminal
event). See [examples/streaming.ts](../examples/streaming.ts).

### `interface AgentHooks`

```ts
interface AgentHooks {
  onEvent?(event: AgentEvent): void | Promise<void>
}
```

### `combineHooks()`

Compose multiple listeners into one. Listeners run in order; a throwing listener
is isolated so it cannot break the run or its siblings.

```ts
function combineHooks(...hooks: Array<AgentHooks | undefined>): AgentHooks
```

### `class UsageTracker`

A ready-made governance hook tallying token usage and tool calls across runs.

```ts
class UsageTracker {
  readonly hooks: AgentHooks            // pass to AgentConfig.hooks
  snapshot(): UsageSnapshot
}

interface UsageSnapshot {
  runs: number
  usage: Usage
  toolCalls: number
}
```

**Example**

```ts
const tracker = new UsageTracker()
const agent = new Agent({ model, hooks: tracker.hooks })
await agent.run('…')
tracker.snapshot() // { runs: 1, usage: {…}, toolCalls: 0 }
```
