# Examples

Runnable examples for every feature of momo-agentic. All but `ai-assistant/` use
a mock model (no API key, no network) so you can run them immediately:

```bash
bun run examples/<name>.ts
```

## Index

| Example | Demonstrates |
| --- | --- |
| [basic.ts](basic.ts) | A first agent: one tool + memory + a hook |
| [tools.ts](tools.ts) | All 3 tool styles (`defineTool`, `BaseTool`, plain), `directReturn`, `ToolRegistry` |
| [multimodal.ts](multimodal.ts) | Pass image / audio / video / file parts to `agent.run` (not just text) |
| [skills.ts](skills.ts) | `defineSkill` + `defineSkillFromManifest`, `result.skillsUsed` |
| [skill-manifest/](skill-manifest/index.ts) | Load a skill from a real `skill.md` file (Bun text import) |
| [planner.ts](planner.ts) | Routing a turn: `respond` / `auto` / `use_tools` + the `plan` event |
| [custom-strategy.ts](custom-strategy.ts) | Replace the ReAct loop via a custom `ReasoningStrategy` |
| [custom-agent.ts](custom-agent.ts) | Bespoke orchestration by extending `BaseAgent` (+ `asTool`) |
| [memory.ts](memory.ts) | Short-term + long-term memory, auto `remember_fact`, `SummarizingMemory` |
| [custom-memory.ts](custom-memory.ts) | Implement the `Memory` port over your own store + semantic `searchFacts` |
| [pgvector-memory/](pgvector-memory/README.md) | Durable long-term **semantic** memory on Postgres + pgvector (Thai-capable via bge-m3) |
| [hybrid-rag/](hybrid-rag/README.md) | **Thai hybrid RAG** (dense + keyword + RRF + rerank) as a `rag_search` tool |
| [tool-provider.ts](tool-provider.ts) | `ToolProvider` / `defineToolProvider` / `collectProviderTools` (non-MCP) |
| [multi-agent.ts](multi-agent.ts) | Multi-agent handoff with `agentAsTool` (Layer 2) |
| [company-agents/](company-agents/README.md) | Company bot: classify a request → route to a department agent (HR/IT/Account/Admin) → tool → form link |
| [hono-api/](hono-api/README.md) | **HTTP API** with Hono: per-user/thread scope, SSE streaming, guardrails, `usageLimiter`, `AgentError`→status |
| [observability.ts](observability.ts) | Every event type + `combineHooks` + `UsageTracker` (Layers 7 + 8) |
| [streaming.ts](streaming.ts) | Stream directReturn results live via `output` events (`streamDirectReturns`) |
| [langfuse-trace.ts](langfuse-trace.ts) | Build a Langfuse-style trace (generations + spans + latency) from the event stream |
| [mongo-trace.ts](mongo-trace.ts) | Persist run logs to MongoDB — one document per run from `result.trace` (+ streaming sketch) |
| [errors-and-abort.ts](errors-and-abort.ts) | `AgentError` stages, `AbortSignal`, `maxSteps` guard |
| [ai-assistant/](ai-assistant/README.md) | **Real** assistant: Gemini 3.0 (`@google/genai`) + MCP (searxng + LLM-wiki) |
| [obsidian-wiki/](obsidian-wiki/README.md) | Use obsidian-llm-wiki (MCP) as a knowledge base, Dockerized via a stdio→HTTP bridge |

## Feature → example map

| Layer / feature | Where to look |
| --- | --- |
| **2 Agent Internet** — `agentAsTool`, `BaseAgent` | `multi-agent.ts`, `company-agents/`, `custom-agent.ts` |
| **3 Protocol** — `ToolProvider`, MCP | `tool-provider.ts`, `ai-assistant/mcp.ts`, `obsidian-wiki/` |
| **Knowledge base / RAG** | `hybrid-rag/` (Thai hybrid + rerank), `pgvector-memory/`, `obsidian-wiki/` |
| **4 Tooling** — tools, `directReturn`, `ToolRegistry` | `tools.ts` |
| **4 Tooling** — tool calls an LLM internally | `tool-internal-llm.ts` |
| **4 Tooling (Skills)** — `defineSkill`, manifest | `skills.ts`, `skill-manifest/` |
| **5 Cognition** — `LanguageModel` adapter | `ai-assistant/gemini-model.ts` |
| **5 Cognition** — `Planner` routing | `planner.ts` |
| **5 Cognition** — `ReasoningStrategy` | `custom-strategy.ts` |
| **6 Memory** — built-ins, `rememberFacts`, summarizing | `memory.ts` |
| **6 Memory** — custom backend + `searchFacts` | `custom-memory.ts`, `pgvector-memory/` |
| **6 Memory** — bound history via summary | `summarizing-memory.ts` |
| **7 Application + 8 Governance** — hooks, `UsageTracker`, tracing | `observability.ts`, `streaming.ts`, `langfuse-trace.ts`, `basic.ts` |
| Robustness — `AgentError`, `AbortSignal`, `maxSteps` | `errors-and-abort.ts` |
| Serving — HTTP API, SSE streaming, multi-tenant | `hono-api/` |

> `_support/mock-model.ts` holds the tiny mock models used across examples. Swap
> them for a real `LanguageModel` (see `ai-assistant/gemini-model.ts`) to go live.
