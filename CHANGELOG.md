# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

When releasing, the section for the tagged version is published verbatim as the
GitHub Release notes (see `.github/workflows/release.yml`).

## [Unreleased]

## [0.3.0] - 2026-06-15

### Added

- **Structured / typed output**: `AgentConfig.responseSchema` exposes a synthetic
  `respond` tool (its parameters = your JSON Schema), instructs the model to answer
  through it, and returns the validated object on `RunResult.object` (its JSON on
  `output`). Optional `parse` (plug zod/ajv) validates/coerces; a built-in check
  enforces `required` keys; invalid output raises `AgentError('response_schema')`.
  Falls back to parsing the output as JSON if the model answers in text. New export:
  `ResponseSchema`; new `RunResult.object` field.
- **Context-window budgeting**: `AgentConfig.contextLimit` (+ optional
  `tokenCounter`, defaulting to a ~4-chars/token heuristic) trims the transcript to
  fit before each model turn — keeping system messages and the latest turn, dropping
  the oldest middle turns first — and emits a `context_trimmed` event. New exports:
  `TokenCounter`, `approxTokenCounter`, `fitContext`.
- **Cost / rate-limit enforcement**: `AgentConfig.usageLimiter` (a `UsageLimiter`
  port) is consulted before each run and can block it with `AgentError('rate_limit')`,
  then records actual token usage after. Ships `InMemoryUsageLimiter` (cap runs and/or
  cumulative tokens per key, with `reset()`). New exports: `UsageLimiter`,
  `LimiterContext`, `LimiterVerdict`, `InMemoryUsageLimiter`, `InMemoryUsageLimiterOptions`.
- **Token streaming**: `LanguageModel.generateStream?` (optional) yields assistant
  text deltas and returns the final `ModelResponse`. When an adapter implements it,
  strategies emit a new `token` `AgentEvent` per delta; otherwise they fall back to
  `generate`. Both `ReActStrategy` and `PlanAndExecuteStrategy` route every model
  call through it. New export: `ModelStreamChunk`.
- **Human-in-the-loop tool approval**: flag a tool with `requiresApproval: true` and
  inject `AgentConfig.toolApprover` (a `ToolApprover` port). Before such a tool runs
  the approver may `allow`, `deny` (the model gets an error result), or `edit` the
  arguments; a `tool_approval` event is emitted. With a guarded tool but no approver,
  the call is denied by default. New exports: `ToolApprover`, `ToolApprovalRequest`,
  `ToolApprovalDecision`; `Tool.requiresApproval`.
- **Input guardrails**: `AgentConfig.inputGuardrails` (`InputGuardrail` ports) run
  BEFORE the model; the first to block short-circuits the turn (the model is never
  called) and returns a replacement/refusal. Symmetric to `outputGuardrails`; the
  `guardrail` event now carries `stage: 'input' | 'output'`. New export: `InputGuardrail`.
- **Resilience**: `withRetry(model, options)` wraps a `LanguageModel` with retry +
  backoff on transient errors (configurable `retries`, `delayMs`, `retryIf`; aborts
  are never retried; streaming retries only before the first token). `AgentConfig.timeoutMs`
  aborts the whole run after a deadline (combined with any `RunOptions.signal`) and
  raises an `AgentError` tagged `"timeout"`. New exports: `withRetry`, `RetryOptions`.
- **Output guardrails (enforcement)**: `AgentConfig.outputGuardrails` takes an
  ordered list of `OutputGuardrail` ports that inspect the final answer after it is
  produced but before it is persisted/returned. The first to return a `pass: false`
  verdict replaces the answer with its `output` (or `DEFAULT_GUARDRAIL_REFUSAL`),
  drops structured `returns`, emits a `guardrail` event, and stops the rest. Where
  the in-prompt `policy` text *asks* the model to behave, these *enforce* it —
  the check is injected, so it can be a term scan, a regex, an external moderation
  API, or a second model call. New exports: `OutputGuardrail`, `GuardrailContext`,
  `GuardrailVerdict`, `DEFAULT_GUARDRAIL_REFUSAL`, and a `guardrail` `AgentEvent`.
  Optional and non-breaking.
- **`AgentConfig.policy`**: dedicated in-prompt safety/policy constraints, kept
  separate from `instructions` (operating instructions) and `persona` (voice).
  Rendered LAST in the system prompt — after persona, instructions, skills, and
  facts — wrapped in framing that declares it overrides everything above and any
  user request, for highest salience. Optional: omit it and the system prompt is
  unchanged.

### Fixed

- **Repeated-call guard no longer oscillates** (`ReActStrategy`): a blocked
  identical tool call now records its signature too, so a call the model re-issues
  with the same arguments on every step stays blocked instead of alternating
  executed/blocked/executed. A genuine re-call is still allowed once another call
  breaks the streak, or when the arguments differ.

### Added

- **`PlanAndExecuteStrategy`** (Layer 5 Cognition): a drop-in `ReasoningStrategy`
  alternative to `ReActStrategy` that plans the whole turn up front, then executes
  it. Three phases — (1) one model call produces an ordered plan via a synthetic
  `create_plan` tool (falling back to parsing a numbered/bulleted list, then to a
  single step over the original request); (2) each step runs through an inner
  strategy (a `ReActStrategy` by default, swappable via `PlanAndExecuteOptions.executor`)
  so a step may call several tools; (3) a final model call synthesizes the answer.
  Usage, trace, `returns`, and `toolsInvoked` are accumulated across all phases, and
  the plan is surfaced via a `plan` hook event. Optional **dynamic re-planning**
  (`PlanAndExecuteOptions.replan`, bounded by `maxReplans`): after each step the
  remaining steps are revised from the results so far via a synthetic `revise_plan`
  tool (an empty revision finishes early), so the plan adapts when a step fails or
  surfaces new information; each revision emits a fresh `plan` event. Tunable with
  `PlanAndExecuteOptions` (`executor`, `executorMaxSteps`, `maxPlanSteps`, `replan`,
  `maxReplans`). Use via `new Agent({ model, strategy: new PlanAndExecuteStrategy() })`.
- **`MemoryStore`** (Layer 6 Memory) + **`Agent.withMemory`**: serve many users —
  each with many threads — from one base agent. `store.for({ userId, threadId })`
  hands out a `Memory` that isolates the short-term conversation per `(userId,
  threadId)` while sharing long-term facts per `userId` across that user's threads;
  underlying stores are created lazily and memoized. Per-tier backends are pluggable
  via `MemoryStoreOptions` (`conversation`, `facts`; `facts: null` for
  conversation-only). `agent.withMemory(memory)` returns a thin clone of the agent
  bound to a given memory, so `base.withMemory(store.for(scope))` is the idiomatic
  per-request pattern. New types: `MemoryScope`, `MemoryStoreOptions`. Non-breaking —
  the `Memory` port signatures are unchanged.

## [0.2.0] - 2026-06-14

### Added

- **Multimodal input**: `agent.run` accepts `string | ContentPart[]`, where a
  `ContentPart` is text or an `image`/`audio`/`video`/`file` referenced by URL or
  inline base64 (`MediaSource`). Parts ride on the user `Message.parts`; a
  `LanguageModel` adapter forwards them to the provider (the Gemini example adapter
  maps them to `fileData`/`inlineData`). `content` keeps a text fallback, derived by
  `partsToText()`. Plain-string input is unchanged.
- `RunResult.returns` (and `ReasoningResult.returns`): raw values returned by
  `directReturn` tools this turn, in call order, with objects preserved — for
  structured output. `output` remains the joined text rendering.
- `output` agent event (`{ value, final }`): streams results as they are produced;
  the turn's final answer is `output` with `final: true`.
- `AgentConfig.streamDirectReturns` (default false): each `directReturn` tool emits
  an `output` event (`final: false`) and the loop continues instead of
  short-circuiting — one turn can surface several results (e.g. multiple cards).
- `step` agent event (`{ step, usage }`) for per-loop token usage; `tool_call` and
  `tool_result` now carry a `step` index, so tokens/tools/returns map to each loop.
- `RunResult.trace` (`StepTrace[]`): the same per-loop breakdown collected on the
  result, for consumers that prefer the final result over hooks.
- Examples: multimodal, streaming, observability (per-loop trace), langfuse-trace,
  mongo-trace, obsidian-wiki (MCP KB, Dockerized; adds `connectSseMcp`),
  pgvector-memory (durable semantic memory), and a Thai hybrid-rag `rag_search`
  tool (dense + keyword + RRF + rerank, ICU Thai word segmentation).

### Changed

- `ReActStrategy` runs a step's tool calls **concurrently** instead of one at a
  time. Results are still recorded in the original call order. A `directReturn`
  tool short-circuits the turn: multiple directReturn messages are joined in call
  order, and a mix of directReturn + normal tools returns the directReturn answer
  (the normal tools still execute).

## [0.1.0] - 2026-06-14

Initial release — a layered, provider-agnostic TypeScript library for building
agentic bots, organized along the 8 architectural layers of agentic AI.

### Added

- **Agent orchestrator** — `Agent` (thin orchestrator), `BaseAgent` (prototype for
  custom agents), `IAgent`, `AgentError`, with `maxSteps`, persona/instructions,
  and `RunResult` (output, messages, steps, usage, toolsInvoked, skillsUsed).
- **Layer 4 — Tooling** — `Tool`, `BaseTool`, `defineTool`, `toToolSchema`,
  `ToolRegistry`, and `directReturn` short-circuiting.
- **Layer 4 — Skills** — `Skill`, `defineSkill`, `BaseSkill`, `SkillRegistry`, and
  `skill.md` manifest loading (`parseSkillManifest`, `defineSkillFromManifest`).
- **Layer 5 — Cognition** — `LanguageModel` provider port, optional `Planner`
  routing, and a swappable `ReasoningStrategy` with the default `ReActStrategy`.
- **Layer 6 — Memory** — `Memory` (short-term conversation + long-term facts),
  `InMemoryMemory`, semantic `searchFacts`, `createRememberTool`, and a
  `SummarizingMemory` decorator.
- **Layer 3 — Protocol** — `ToolProvider`, `defineToolProvider`,
  `collectProviderTools` for importing external (MCP-style) tools.
- **Layer 2 — Agent Internet** — `agentAsTool` for multi-agent handoff.
- **Layers 7 + 8 — Observability** — typed `AgentEvent` stream, `AgentHooks`,
  `combineHooks`, and a `UsageTracker` governance hook.
- **Examples** — a runnable example per feature (mock-model based) plus a real
  Gemini 3.0 (`@google/genai`) + MCP (searxng, LLM-wiki) assistant.
- **Docs** — TypeDoc API site with an inline Examples page, deployed to GitHub
  Pages; hand-written `docs/API.md`.
- **Tests & CI** — 49 tests incl. a public-API surface guard and a
  regression/contract suite; CI runs lint + typecheck + tests with JUnit + LCOV
  reports on every push and PR.

[Unreleased]: https://github.com/snlangsuan/momo-agentic/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/snlangsuan/momo-agentic/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/snlangsuan/momo-agentic/releases/tag/v0.1.0
