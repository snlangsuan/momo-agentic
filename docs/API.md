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
- [Redis backends](#redis-backends--momo-agenticredis)
- [MongoDB backend](#mongodb-backend--momo-agenticmongo)
- [A2A interop](#a2a-interop--momo-agentica2a)

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
  run(input: RunInput, options?: RunOptions): Promise<RunResult>   // RunInput = string | ContentPart[]
  withMemory(memory: Memory): Agent           // bind a per-scope memory (see MemoryStore)
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
  policy?: string               // in-prompt safety constraints, rendered LAST (overrides all). Asks; see guardrails to enforce
  tools?: Tool[]                // locally-registered tools (Layer 4)
  skills?: Skill[]              // named tool bundles + instruction fragments (Layer 4)
  toolProviders?: ToolProvider[]// external tool sources resolved at run time (Layer 3)
  toolApprover?: ToolApprover   // human-in-the-loop gate for tools flagged `requiresApproval` (Layer 4)
  streamDirectReturns?: boolean // stream directReturn results as `output` events; default false
  planner?: Planner             // optional routing / tool-narrowing (Layer 5)
  strategy?: ReasoningStrategy  // reasoning algorithm. Default: new ReActStrategy()
  responseSchema?: ResponseSchema // structured output: answer via a synthetic `respond` tool → RunResult.object
  memory?: Memory               // memory backend. Default: new InMemoryMemory()
  rememberFacts?: boolean       // auto-add a `remember_fact` tool. Default false
  factRecallLimit?: number      // max facts injected per turn. Default 8
  hooks?: AgentHooks            // event hooks (Layers 7 + 8)
  usageLimiter?: UsageLimiter   // governance: per-run/token ceiling; blocks with AgentError('rate_limit') (Layer 8)
  inputGuardrails?: InputGuardrail[]   // enforced checks BEFORE the model; first block short-circuits (Layer 8)
  outputGuardrails?: OutputGuardrail[] // enforced checks AFTER the answer; first block replaces it (Layer 8)
  maxSteps?: number             // hard cap on loop iterations. Default 10
  contextLimit?: number         // trim transcript to ≤ this many tokens per model turn (uses tokenCounter). Default: no limit
  tokenCounter?: TokenCounter   // counter for contextLimit. Default: ~4-chars/token heuristic (approxTokenCounter)
  timeoutMs?: number            // abort the run after N ms → AgentError('timeout'). Default: no timeout
  runStore?: RunStore           // durable runs: checkpoint each step under RunOptions.runId; resume after a crash (Layer 8)
}
```

Notes:
- `rememberFacts: true` requires a memory backend exposing `rememberFact`.
- When the full fact set is ≤ `factRecallLimit`, all facts are injected; beyond
  that, the backend's `searchFacts` ranks by relevance to the input.
- `policy` only *asks* the model to comply; for *enforced* checks use
  `inputGuardrails` / `outputGuardrails`.

### `RunOptions`

```ts
interface RunOptions {
  signal?: AbortSignal                  // propagated to model + tools
  metadata?: Record<string, unknown>    // merged into each ToolContext.metadata
  runId?: string                        // durable runs: checkpoint this run under this id (needs AgentConfig.runStore)
  resume?: boolean                      // resume a prior checkpoint for runId (no-op if none exists)
  hooks?: AgentHooks                    // per-run event hooks, combined with AgentConfig.hooks for this run only
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
  usage: Usage            // token totals (across all models)
  usageByModel: Record<string, Usage>  // token totals split by the model id that produced them
  toolsInvoked: string[]  // tool names in call order (with repeats)
  skillsUsed: string[]    // deduped skills whose tools were invoked
  object?: unknown        // validated structured answer; present only with responseSchema (its JSON on `output`)
}

interface StepTrace {
  step: number
  model?: string          // id of the model that produced this call (for per-model attribution)
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

### `interface ResponseSchema`

Typed final output. Set `AgentConfig.responseSchema` and the agent exposes a
synthetic `respond` tool whose parameters **are** your JSON Schema, instructs the
model to answer through it, and returns the validated object on `RunResult.object`
(its JSON on `output`). A built-in check enforces the schema's `required` keys;
plug `parse` (zod/ajv) for full validation. Invalid output raises `AgentError('response_schema')`.

```ts
interface ResponseSchema<T = unknown> {
  schema: Record<string, unknown>   // JSON Schema for the answer object (= the tool's parameters)
  name?: string                     // synthetic tool name. Default 'respond'
  description?: string              // tool description shown to the model
  parse?: (data: unknown) => T      // optional validator/coercer; its return becomes RunResult.object
  repair?: number                   // on validation failure, re-ask the model up to N more times. Default 0
}
```

With `repair` set, an answer that fails the required-keys check or `parse` is sent
back to the model with the error, and it gets up to `repair` more attempts before
the run raises `AgentError('response_schema')`. Usage/trace from each attempt are
merged into the result.

```ts
const agent = new Agent({ model, responseSchema: { schema: {
  type: 'object',
  properties: { sentiment: { type: 'string' }, score: { type: 'number' } },
  required: ['sentiment'],
} } })
const result = await agent.run('I love this!')
result.object // → { sentiment: 'positive', score: 0.9 }
```

### `interface IAgent`

The agent contract. Anything implementing it can be composed and exposed as a tool.

```ts
interface IAgent {
  readonly name: string
  run(input: RunInput, options?: RunOptions): Promise<RunResult>   // RunInput = string | ContentPart[]
}
```

### `abstract class BaseAgent`

Prototype base class for **custom** agents. Extend it to write a bespoke
orchestration while staying composable; subclasses get `asTool()` for free.

```ts
abstract class BaseAgent implements IAgent {
  abstract readonly name: string
  abstract run(input: RunInput, options?: RunOptions): Promise<RunResult>
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

### MCP client — `momo-agentic/mcp`

Connect to a [Model Context Protocol](https://modelcontextprotocol.io) server and
expose its tools as a `ToolProvider`. Built on the optional peer dependency
`@modelcontextprotocol/sdk`; shipped as a subpath to keep the core dependency-free.
The connection is established lazily on first `listTools()` and reused; `close()`
disconnects.

```ts
import { mcpToolProvider } from 'momo-agentic/mcp'

function mcpToolProvider(options: McpToolProviderOptions): ToolProvider

interface McpToolProviderOptions {
  name?: string                       // provider name (logs). Default 'mcp'
  client?: { name?: string; version?: string }  // identity sent on initialize
  stdio?: McpStdioConfig              // launch a local server over stdio
  url?: string | URL                 // connect to a Streamable HTTP endpoint
  headers?: Record<string, string>   // extra HTTP headers for `url`
  transport?: Transport              // a pre-built @modelcontextprotocol/sdk transport
  toolPrefix?: string                // prefix each remote tool name (avoid collisions)
}

interface McpStdioConfig {
  command: string                    // executable, e.g. 'npx'
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}
```

Provide exactly one of `transport`, `stdio`, or `url`.

```ts
const fs = mcpToolProvider({
  stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
  toolPrefix: 'fs_',
})
const agent = new Agent({ model, toolProviders: [fs] })
// ... when done:
await fs.close()
```

---

## Layer 4 — Tooling

The agent's callable capabilities.

### `interface Tool`

```ts
interface Tool<TArgs = Record<string, unknown>> extends ToolSchema {
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown
  directReturn?: boolean      // if true, the result becomes the final answer (loop exits)
  requiresApproval?: boolean  // gate the call behind AgentConfig.toolApprover before it runs
  timeoutMs?: number          // abort this tool if it runs longer; model gets a timeout error
  parse?(args: Record<string, unknown>): TArgs  // validate/coerce before execute, or throw
}
```

A non-string `execute` return is JSON-serialized before being fed back to the
model. For `directReturn`, return `{ message: string }` or a plain string.

**Argument validation.** Before `execute` runs, the model-supplied arguments are
checked against `parameters` (required keys + top-level primitive/union types).
A failure becomes an error the model sees and can correct — not a crash or a
silently-wrong call. The optional `parse` hook runs after that built-in check for
deeper validation/coercion (e.g. `parse: (a) => MySchema.parse(a)`); throwing
rejects the call and feeds the message back to the model.

**Per-tool timeout.** Set `timeoutMs` to bound a single tool call. On timeout the
tool's `context.signal` is aborted (so a cooperative tool can cancel) and the
model receives a timeout error — one hung tool can't stall the whole run. This is
independent of the run-wide `AgentConfig.timeoutMs`.

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
  requiresApproval?: boolean              // route through the run's ToolApprover before executing
  timeoutMs?: number                      // abort the call if it runs longer
  parse?(args: Record<string, unknown>): TArgs  // validate/coerce before execute, or throw
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

### Human-in-the-loop — `ToolApprover`

Mark a tool `requiresApproval: true` and inject an `AgentConfig.toolApprover`: before
the tool runs, the approver is consulted and may **allow** it, **deny** it (the model
gets an error instead of a result), or **edit** its arguments. With a guarded tool but
no approver, the call is denied by default. Each decision emits a `tool_approval` event.

```ts
interface ToolApprover {
  readonly name: string
  approve(request: ToolApprovalRequest): Promise<ToolApprovalDecision> | ToolApprovalDecision
}

interface ToolApprovalRequest {
  agentName: string
  tool: string                        // name of the tool awaiting approval
  args: Record<string, unknown>       // arguments the model wants to use
  metadata: Record<string, unknown>   // per-run data from RunOptions.metadata
  signal?: AbortSignal
}

type ToolApprovalDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason?: string }                 // reason fed back to the model
  | { decision: 'edit'; args: Record<string, unknown> }   // run with substituted arguments
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
  // OPTIONAL token streaming: yield text deltas, RETURN the final ModelResponse.
  // When implemented, strategies emit `token` events; otherwise they fall back to generate().
  generateStream?(options: GenerateOptions): AsyncGenerator<ModelStreamChunk, ModelResponse, void>
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

interface ModelStreamChunk {
  delta: string   // text appended since the previous chunk
}
```

### Built-in adapters — `momo-agentic/gemini`, `momo-agentic/openai`

Ready-made `LanguageModel` implementations for common providers, shipped behind
separate entry points so the core stays dependency-free. The provider SDK is an
**optional peer dependency** — install only the one you import. Both adapters
support tool calling, multimodal input, `generateStream`, and usage reporting.

```ts
// momo-agentic/gemini  — needs `@google/genai`
import { createGeminiModel } from 'momo-agentic/gemini'

type GeminiModelOptions =
  | { vertexai?: false; apiKey: string; model?: string; temperature?: number }
  | { vertexai: true; project: string; location: string; model?: string; temperature?: number }

function createGeminiModel(options: GeminiModelOptions): LanguageModel
// Developer API:  createGeminiModel({ apiKey })
// Vertex AI:      createGeminiModel({ vertexai: true, project, location })  // ADC auth
// model defaults to 'gemini-3.0-pro'.
```

```ts
// momo-agentic/openai  — needs `openai`. Covers OpenAI + any OpenAI-compatible host.
import { createOpenAIModel } from 'momo-agentic/openai'

interface OpenAIModelOptions {
  model: string
  apiKey?: string          // optional for local servers that don't require one
  baseURL?: string         // point at Groq / Together / OpenRouter / Ollama / vLLM / …
  headers?: Record<string, string>
  organization?: string
  temperature?: number
  maxTokens?: number
}

function createOpenAIModel(options: OpenAIModelOptions): LanguageModel
// OpenAI:            createOpenAIModel({ apiKey, model: 'gpt-4o-mini' })
// OpenAI-compatible: createOpenAIModel({ baseURL: 'http://localhost:11434/v1', model: 'llama3.1' })
```

### Response caching — `cacheModel`, `ModelCache`, `InMemoryModelCache`

A `LanguageModel` decorator that memoizes completions by their exact input (model
id + transcript + tools), serving identical requests from a `ModelCache` instead
of paying the provider again. The cache is an injected port; `InMemoryModelCache`
ships for single-instance use (swap in Redis/etc. for multi-instance). Like
`redactModel`, the wrapper exposes only `generate` (a cache hit has no tokens to
stream).

```ts
function cacheModel(model: LanguageModel, options?: CacheModelOptions): LanguageModel

interface CacheModelOptions {
  cache?: ModelCache                                       // default: new InMemoryModelCache()
  key?: (model: LanguageModel, options: GenerateOptions) => string  // default: stable JSON
}

interface ModelCache {
  get(key: string): Promise<ModelResponse | undefined> | ModelResponse | undefined
  set(key: string, value: ModelResponse): Promise<void> | void
}

class InMemoryModelCache implements ModelCache {
  constructor(options?: { ttlMs?: number; maxEntries?: number })  // maxEntries default 1000
  clear(): void
}

const cached = cacheModel(model, { cache: new InMemoryModelCache({ ttlMs: 60_000 }) })
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
  messages: Message[]            // working transcript; the strategy appends to it
  maxSteps: number
  toolContext: ToolContext
  hooks?: AgentHooks
  signal?: AbortSignal
  approver?: ToolApprover        // HITL gate consulted before any `requiresApproval` tool
  streamDirectReturns?: boolean  // stream directReturn results as partial `output` events; default false
}

interface ReasoningResult {
  output: string
  returns: unknown[]      // raw directReturn tool values, in call order (objects preserved); [] if none
  trace: StepTrace[]      // per-loop breakdown: tokens, text, tools + return values (see RunResult)
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

### `class PlanAndExecuteStrategy`

An alternative strategy that splits a turn into **plan** (break the request into
ordered steps) → **execute** (run each step through an inner strategy, a fresh
`ReActStrategy` by default) → **synthesize** (compose the final answer). Drop-in for
`AgentConfig.strategy`; returns the same `ReasoningResult` shape.

```ts
class PlanAndExecuteStrategy implements ReasoningStrategy {
  constructor(options?: PlanAndExecuteOptions)
  readonly name: string
  run(input: ReasoningInput): Promise<ReasoningResult>
}

interface PlanAndExecuteOptions {
  executor?: ReasoningStrategy   // strategy per plan step. Default: a fresh ReActStrategy
  planningModel?: LanguageModel  // model for planning + re-planning. Default: the Agent's model
  executorMaxSteps?: number      // inner maxSteps per step. Default: the run's maxSteps
  maxPlanSteps?: number          // hard cap on plan steps (extra dropped). Default 10
  replan?: boolean               // re-plan remaining steps after each step. Default false
  maxReplans?: number            // max re-plan attempts when `replan` is on. Default 3
}
```

Set `planningModel` to run the planning (and re-planning) calls on a separate
model — e.g. a cheaper/faster one — while step execution and final synthesis keep
using the Agent's main `model`. This is the per-component way to mix models within
one turn; see also `createModelSummarizer(model)` (summarization) and `agentAsTool`
(each agent has its own model).

### `withRetry()`

Wrap a `LanguageModel` so transient provider failures (rate limits, 5xx, dropped
connections) are retried with backoff. Transparent decorator: same `id`, honors the
same `signal` (an aborted run stops retrying at once). For `generateStream`, only a
failure before the first token is retried.

```ts
function withRetry(model: LanguageModel, options?: RetryOptions): LanguageModel

interface RetryOptions {
  retries?: number                       // attempts after the first try (total = retries + 1). Default 2
  delayMs?: (attempt: number) => number  // backoff per attempt (1-based). Default: exponential, capped 5s
  retryIf?: (error: unknown) => boolean  // is an error retryable. Default: anything that is not an abort
}
```

```ts
const agent = new Agent({ model: withRetry(myModel, { retries: 3 }) })
```

### `withFallback()`

Chain models into a primary-with-fallbacks. A call tries the first model and, on a
qualifying error, falls through to the next. Transparent decorator with a stable
`id` (the primary's by default) so cache keys and `step`/`token` attribution stay
consistent. For `generateStream`, fallback only happens before the first token.
Compose with `withRetry` to retry each model before moving on.

```ts
function withFallback(models: LanguageModel[], options?: FallbackOptions): LanguageModel

interface FallbackOptions {
  fallbackIf?: (error: unknown) => boolean   // trigger fallback? Default: anything not an abort
  onFallback?: (info: { error: unknown; from: string; to: string }) => void  // observe handoffs
  id?: string                                // id for the combined model. Default: the primary's
}
```

```ts
const model = withFallback([withRetry(opus), withRetry(haiku)], {
  onFallback: ({ from, to }) => console.warn(`${from} → ${to}`),
})
```

### Context-window budgeting — `TokenCounter`, `approxTokenCounter`, `fitContext`

Trim a transcript to fit a token budget. The `Agent` does this automatically when
`AgentConfig.contextLimit` is set (using `tokenCounter`); `fitContext` is the
standalone primitive. All `system` messages and the final message are always kept;
the oldest of the rest drop first.

```ts
interface TokenCounter {
  count(text: string): number
}

const approxTokenCounter: TokenCounter   // zero-dependency heuristic, ~4 chars/token

function fitContext(
  messages: Message[],
  options: { counter: TokenCounter; limit: number },
): Message[]   // a trimmed copy
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

### `class MemoryStore` (multi-user / multi-thread)

Hands out a per-scope `Memory` from one process: short-term conversation isolated
per `(userId, threadId)`, long-term facts shared per `userId`. Stores are created
lazily and memoized. Pair with `Agent.withMemory` to bind a thin per-request agent.

```ts
class MemoryStore {
  constructor(options?: MemoryStoreOptions)
  for(scope: MemoryScope): Memory   // composed memory for one scope (cached per scope)
}

interface MemoryScope {
  userId: string     // long-term facts shared across this user's threads
  threadId: string   // short-term history isolated per thread
}

interface MemoryStoreOptions {
  conversation?: (scope: MemoryScope) => ConversationMemory  // Default: fresh InMemoryMemory per scope
  facts?: ((userId: string) => FactMemory) | null            // Default: fresh InMemoryMemory per user; null = no facts
}
```

```ts
const store = new MemoryStore()
const base = new Agent({ model, tools })
const agentFor = (userId: string, threadId: string) =>
  base.withMemory(store.for({ userId, threadId }))
```

---

## Layers 7 + 8 — Observability

One typed event stream for the Application (UI) and Governance (monitoring/metering).

### `type AgentEvent`

```ts
type AgentEvent =
  | { type: 'run_start';       agent: string; input: string }
  | { type: 'plan';            agent: string; mode: string; tools?: string[]; reason?: string }
  | { type: 'thinking';        agent: string; text: string }
  | { type: 'token';           agent: string; delta: string; model?: string }   // streamed assistant-text delta (model = its id)
  | { type: 'context_trimmed'; agent: string; dropped: number; tokens: number }  // history trimmed to contextLimit
  | { type: 'step';            agent: string; step: number; usage: Usage; model?: string }  // model = id that handled this call
  | { type: 'tool_call';       agent: string; step: number; tool: string; args: Record<string, unknown> }
  | { type: 'tool_approval';   agent: string; step: number; tool: string; decision: 'allow' | 'deny' | 'edit'; reason?: string }
  | { type: 'tool_result';     agent: string; step: number; tool: string; result: unknown }
  | { type: 'message';         agent: string; message: Message }
  | { type: 'output';          agent: string; value: unknown; final: boolean }
  | { type: 'usage';           agent: string; usage: Usage; tools: string[]; skills: string[] }
  | { type: 'guardrail';       agent: string; name: string; stage: 'input' | 'output'; reason?: string }
  | { type: 'error';           agent: string; stage: string; error: Error }
  | { type: 'run_end';         agent: string; output: string; usage: Usage }
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

### Cost / rate-limit enforcement — `UsageLimiter`

Where `UsageTracker` *measures*, a `UsageLimiter` *enforces*: consulted before every
run (it may block with `AgentError('rate_limit')`) and told the actual usage after.
Pass one as `AgentConfig.usageLimiter`. `InMemoryUsageLimiter` is a ready-made
in-process limiter capping runs and/or cumulative tokens per key.

```ts
interface UsageLimiter {
  readonly name: string
  acquire(context: LimiterContext): Promise<LimiterVerdict> | LimiterVerdict  // before a run; block to deny
  record?(usage: Usage, context: LimiterContext): Promise<void> | void        // after a run, for accounting
}

interface LimiterContext {
  agentName: string
  input: string                       // the user's input for this turn
  metadata: Record<string, unknown>   // per-run data (e.g. a userId to key on)
}

type LimiterVerdict = { allowed: true } | { allowed: false; reason?: string }

class InMemoryUsageLimiter implements UsageLimiter {
  constructor(options: InMemoryUsageLimiterOptions)
  acquire(context: LimiterContext): LimiterVerdict
  record(usage: Usage, context: LimiterContext): void
  reset(): void   // clear all counters (e.g. when a window rolls over)
}

interface InMemoryUsageLimiterOptions {
  maxRuns?: number    // max runs per key
  maxTokens?: number  // max cumulative total tokens per key
  key?: (context: LimiterContext) => string   // bucket key. Default: one global bucket
}
```

```ts
const limiter = new InMemoryUsageLimiter({ maxRuns: 100, key: (c) => String(c.metadata.userId) })
const agent = new Agent({ model, usageLimiter: limiter })
```

### Guardrails — `InputGuardrail`, `OutputGuardrail`

Enforced checks (the in-prompt `AgentConfig.policy` only asks; these enforce).
Input guardrails run BEFORE the model — the first to block short-circuits the turn,
the model is never called. Output guardrails run AFTER the answer — the first to
block replaces it (and drops structured `returns`). Both emit a `guardrail` event.
Pass via `AgentConfig.inputGuardrails` / `outputGuardrails`.

```ts
interface InputGuardrail {
  readonly name: string
  check(input: string, context: GuardrailContext): Promise<GuardrailVerdict> | GuardrailVerdict
}

interface OutputGuardrail {
  readonly name: string
  check(output: string, context: GuardrailContext): Promise<GuardrailVerdict> | GuardrailVerdict
}

interface GuardrailContext {
  agentName: string
  input: string                       // the turn's input (the prompt that produced the output)
  signal?: AbortSignal
  metadata: Record<string, unknown>
}

// Block without `output` → falls back to DEFAULT_GUARDRAIL_REFUSAL.
type GuardrailVerdict = { pass: true } | { pass: false; output?: string; reason?: string }

const DEFAULT_GUARDRAIL_REFUSAL: string   // "I'm sorry, but I can't help with that."
```

### Sensitive-data redaction — `createRedactor`, `redactModel`, `redactHooks`

A data-minimization utility for keeping PII/secrets out of systems that don't need
them. Detection is an injected `RedactionRule[]` (`g`-flagged patterns) plus a list of
exact `values`; `BUILTIN_REDACTION_RULES` ships conservative defaults (email, credit
card, US SSN, IPv4, `sk-`/`pk-` keys, loose phone). Two modes match the two boundaries
a value can cross:

- **Reversible tokenization** — `redact()` swaps each value for a stable placeholder
  (e.g. `[REDACTED_EMAIL_1]`) and remembers it; `restore()` puts the real value back.
- **Irreversible masking** — `mask()` swaps each value for a category tag (e.g. `[EMAIL]`)
  with no way back.

```ts
interface RedactionRule {
  name: string                          // category, e.g. 'email' → placeholder/tag
  pattern: RegExp                       // must be g-flagged
  mask?: (match: string) => string      // custom masked form; defaults to `[NAME]`
}

interface RedactorOptions {
  rules?: RedactionRule[]               // defaults to BUILTIN_REDACTION_RULES
  values?: string[]                     // exact literals to always redact (matched first, longest-first)
  placeholder?: (name: string, index: number) => string  // default `[REDACTED_${name}_${index}]`
}

interface Redactor {
  redact(text: string): string          // reversible: value → placeholder (remembers mapping)
  restore(text: string): string         // reverse a previous redact()
  mask(text: string): string            // irreversible: value → category tag
  readonly size: number                 // distinct values held in the vault
}

function createRedactor(options?: RedactorOptions): Redactor
const BUILTIN_REDACTION_RULES: RedactionRule[]
```

Two port wrappers apply a redactor at the trust boundaries:

```ts
// De-identify the transcript before the provider, re-identify the response. The
// vault is scoped per generate() call and never leaves the host. generateStream
// is intentionally NOT exposed (so placeholders are whole before restore) —
// strategies transparently fall back to the buffered generate().
function redactModel(model: LanguageModel, options?: RedactorOptions): LanguageModel

// Irreversibly mask every event (input/output/deltas, message content, tool
// args/results) before it reaches the inner logger/tracer. No restore.
function redactHooks(hooks: AgentHooks, options?: RedactorOptions): AgentHooks
```

```ts
const safeModel = redactModel(providerModel, { values: [process.env.DB_URL!] })
const agent = new Agent({
  model: safeModel,                                  // provider never sees real PII
  hooks: redactHooks({ onEvent: (e) => log(e) }),    // logs never hold real PII
})
```

### Evaluation — `evaluate`, scorers

Run an agent over a dataset and score the answers — a regression test for agent
*behavior*. Scorers are injected functions, so a check can be anything (exact /
substring / regex match, "used the right tool", or LLM-as-judge). Pair with the
`ScriptedModel` test helper to replay fixed responses, or a real provider for live
quality.

```ts
interface EvalCase { name?: string; input: RunInput; expected?: string; metadata?: Record<string, unknown> }
interface EvalSample { case: EvalCase; result: RunResult }
interface Score { name: string; score: number /* 0..1 */; passed: boolean; detail?: string }
type Scorer = (sample: EvalSample) => Score | Promise<Score>

interface EvaluateOptions { scorers: Scorer[]; concurrency?: number; runOptions?: RunOptions }

interface CaseResult { case: EvalCase; output: string; usage: Usage; scores: Score[]; passed: boolean }
interface EvalReport {
  cases: CaseResult[]
  total: number
  passed: number
  passRate: number                      // passed / total
  meanScores: Record<string, number>    // mean score per scorer name
}

function evaluate(agent: IAgent, dataset: EvalCase[], options: EvaluateOptions): Promise<EvalReport>

// Built-in scorers (each returns a Scorer):
function exactMatch(options?: { name?; caseInsensitive?; trim? }): Scorer   // output === case.expected
function includesText(text: string, options?): Scorer                       // output contains text
function matchesRegex(pattern: RegExp, options?: { name? }): Scorer         // output matches pattern
function usedTool(tool: string, options?: { name? }): Scorer               // run invoked the tool
```

```ts
const report = await evaluate(agent, [
  { input: 'capital of France?', expected: 'Paris' },
  { input: 'what time is it in Tokyo?' },
], { scorers: [includesText('Paris'), usedTool('get_time')], concurrency: 4 })

console.log(report.passRate, report.meanScores)
```

### Durable runs — `RunStore`, `RunCheckpoint`, `InMemoryRunStore`

Persist a checkpoint after every reasoning step so a process that dies mid-loop
can RESUME instead of restarting. Enable by giving a run a `runId` (with
`AgentConfig.runStore`); the checkpoint is saved each step and deleted on success.
Resume with `{ runId, resume: true }`. The store is an injected port —
`InMemoryRunStore` ships; wrap Redis/Postgres for cross-process durability.

Resume is **at-least-once**: a tool that finished before the crash is already in
the saved transcript and is not re-run, but a tool in flight at crash time runs
again on resume — so durable tools should be idempotent.

```ts
interface RunCheckpoint {
  runId: string
  input: string
  messages: Message[]
  step: number
  toolsInvoked: string[]
  usage: Usage
  status: 'running' | 'done'
}

interface RunStore {
  load(runId: string): Promise<RunCheckpoint | undefined> | RunCheckpoint | undefined
  save(checkpoint: RunCheckpoint): Promise<void> | void
  delete(runId: string): Promise<void> | void
}

class InMemoryRunStore implements RunStore {}
```

```ts
const agent = new Agent({ model, tools, runStore: new InMemoryRunStore() })

try {
  await agent.run('long multi-step task', { runId: 'job-42' })  // checkpoints each step
} catch {
  // process restarts… later, with the same store:
  const result = await agent.run('long multi-step task', { runId: 'job-42', resume: true })
}
```

## Redis backends — `momo-agentic/redis`

Ready-to-use Redis implementations of the persistence ports, behind a separate
entry point. `ioredis` is an **optional peer dependency**, imported for types
only — the bundle has no runtime dependency; you pass a connected client in. For
multi-tenant memory, create one `RedisMemory` per `namespace` (e.g. per
`userId:threadId`).

```ts
import Redis from 'ioredis'
import { RedisMemory, RedisModelCache, RedisRunStore } from 'momo-agentic/redis'
import { Agent, cacheModel } from 'momo-agentic'

const redis = new Redis(process.env.REDIS_URL)

class RedisMemory implements Memory {            // conversation (list) + facts (hash)
  constructor(redis: Redis, options: { namespace: string; ttlSeconds?: number })
}
class RedisModelCache implements ModelCache {    // shared LLM cache for cacheModel
  constructor(redis: Redis, options?: { keyPrefix?: string; ttlSeconds?: number })
}
class RedisRunStore implements RunStore {        // durable runs across processes
  constructor(redis: Redis, options?: { keyPrefix?: string; ttlSeconds?: number })
}

const agent = new Agent({
  model: cacheModel(provider, { cache: new RedisModelCache(redis) }),
  memory: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 }),
  runStore: new RedisRunStore(redis),
})
```

## MongoDB backend — `momo-agentic/mongo`

`MongoMemory` implements the full `Memory` (conversation in a messages
collection, durable facts in a per-namespace document). `mongodb` is an
**optional, type-only peer dependency**.

```ts
import { MongoClient } from 'mongodb'
import { MongoMemory } from 'momo-agentic/mongo'

class MongoMemory implements Memory {
  constructor(db: Db, options: { namespace: string; messagesCollection?: string; factsCollection?: string })
}

const db = (await MongoClient.connect(process.env.MONGO_URL!)).db('app')
const agent = new Agent({ model, memory: new MongoMemory(db, { namespace: `user:${userId}` }) })
```

### Mixing tiers — `composeMemory`

The two memory ports are independent, so short-term and long-term can use
DIFFERENT stores. `composeMemory` (core, zero-dep) stitches one of each into a
single `Memory` — e.g. fast/TTL'd conversation in Redis + durable facts in Mongo.

```ts
import { composeMemory } from 'momo-agentic'
import { RedisMemory } from 'momo-agentic/redis'
import { MongoMemory } from 'momo-agentic/mongo'

function composeMemory(options: { conversation: ConversationMemory; facts?: FactMemory }): Memory

const memory = composeMemory({
  conversation: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 }),
  facts: new MongoMemory(db, { namespace: `user:${userId}` }),
})
const agent = new Agent({ model, memory, rememberFacts: true })
```

## A2A interop — `momo-agentic/a2a`

Make a momo agent interoperate over the [A2A (Agent2Agent)](https://a2a-protocol.org)
protocol, both directions. Dependency-free — the server returns a Web `Response`,
the client uses `fetch`. Covers discovery, `message/send`, `message/stream`
(**token-level SSE**), `tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/{set,get}`
(webhook on completion), `input-required` multi-turn (via an opt-in `needsInput`
predicate), and auth (Agent Card `securitySchemes` + client `headers`).

### Server — `serveA2A`

```ts
import { serveA2A } from 'momo-agentic/a2a'

interface ServeA2AOptions {
  url: string                  // public JSON-RPC endpoint
  version: string
  name?: string                // defaults to agent.name
  description?: string
  skills?: A2AAgentSkill[]      // defaults to one catch-all skill
  protocolVersion?: string      // default '0.3.0'
  taskStore?: A2ATaskStore      // enables tasks/get (ships InMemoryA2ATaskStore)
  securitySchemes?: Record<string, unknown>          // advertised in the Agent Card
  security?: Array<Record<string, string[]>>          // required schemes → scopes
  needsInput?: (result: RunResult) => boolean         // true → task ends 'input-required'
  fetch?: typeof fetch                                 // used to POST push notifications
}

interface A2AServer {
  readonly card: A2AAgentCard               // serve at /.well-known/agent-card.json
  handle(request: Request): Promise<Response> // message/send, message/stream, tasks/get, tasks/cancel
}

// Pass an agent, OR a resolver to scope memory per A2A contextId.
type A2AAgentResolver = (contextId: string) => IAgent | Promise<IAgent>
function serveA2A(agent: IAgent | A2AAgentResolver, options: ServeA2AOptions): A2AServer
```

Mount it in any Web-standard server:

```ts
const a2a = serveA2A(agent, { url: 'https://me/a2a', version: '1.0.0' })
Bun.serve({
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/.well-known/agent-card.json') return Response.json(a2a.card)
    if (pathname === '/a2a') return a2a.handle(req)
    return new Response('not found', { status: 404 })
  },
})
```

### Client — `a2aAgentAsTool`

The network counterpart to `agentAsTool`: discover a remote A2A agent via its
Card and expose it as a `Tool`, so a lead agent can delegate across hosts/orgs.

```ts
import { a2aAgentAsTool, fetchAgentCard } from 'momo-agentic/a2a'

interface A2AAgentAsToolOptions {
  name?: string                 // defaults to the remote agent's (sanitized) name
  description?: string          // defaults to the Card's description
  headers?: Record<string, string> // e.g. Authorization for secured agents
  stream?: boolean              // use message/stream (SSE) and aggregate the answer
  fetch?: typeof fetch          // inject for proxy/auth/tests
}

function a2aAgentAsTool(cardUrl: string, options?: A2AAgentAsToolOptions): Promise<Tool>
function fetchAgentCard(cardUrl: string, fetchImpl?: typeof fetch): Promise<A2AAgentCard>

const remote = await a2aAgentAsTool('https://other-org/agent/.well-known/agent-card.json')
const lead = new Agent({ model, tools: [remote] })   // delegates over A2A
```

Also exported: the A2A wire types (`A2AAgentCard`, `A2AMessage`, `A2APart`,
`A2ATask`, `A2AArtifact`, status/artifact update events, JSON-RPC envelopes) and
mapping helpers (`partsToRunInput`, `resultToArtifact`, `extractText`).
