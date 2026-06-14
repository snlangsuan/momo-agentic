# Example: AI assistant with Gemini 3.0 + MCP tools

A complete, runnable assistant built from momo-agentic layers:

| Layer | Used here |
| --- | --- |
| 5 Cognition | [`gemini-model.ts`](gemini-model.ts) — a `LanguageModel` over `@google/genai` (Gemini 3.0) |
| 3 Protocol | [`mcp.ts`](mcp.ts) — adapts any MCP server to a `ToolProvider` |
| 4 Tooling | tools come from the MCP servers (searxng, llm-wiki) |
| 6 Memory | in-process conversation + facts, with an auto `remember_fact` tool |
| 7 + 8 Observability | streaming hook + `UsageTracker` |

```
gemini-model.ts   Gemini 3.0 adapter (@google/genai)  → LanguageModel
mcp.ts            MCP client → ToolProvider adapter (+ stdio/HTTP connect helpers)
assistant.ts      assembles the Agent (model + providers + memory + hooks)
run.ts            entrypoint: connect MCP servers, run a query, print usage
```

## How it fits together

```
                ┌──────────────────────────── Agent (assistant) ───────────────┐
  user query →  │  Memory(history+facts) → Gemini 3.0 (LanguageModel) ⇄ tools  │ → answer
                └───────────────────────────────────┬───────────────────────────┘
                                                     │ tools resolved at run time
                          ┌──────────────────────────┴───────────────────────────┐
                   ToolProvider "searxng"                              ToolProvider "llm-wiki"
                   (MCP stdio: web search)                            (MCP stdio/HTTP: knowledge base)
```

The agent is provider-agnostic — swap `geminiModel(...)` for any other
`LanguageModel`, or add/remove MCP providers, without touching the assistant.

## Prerequisites

1. **Gemini API key** — from Google AI Studio.
2. **A SearXNG instance** + an MCP server that wraps it. A common one is
   [`mcp-searxng`](https://www.npmjs.com/package/mcp-searxng) (run via `npx`).
   You need a reachable SearXNG with JSON output enabled (`SEARXNG_URL`).
3. **An "LLM wiki" knowledge-base MCP server** — any MCP server exposing search
   over your docs (e.g. a docs/RAG MCP server). Replace the placeholder command
   `@your-org/llm-wiki-mcp` with your real one, or point `LLM_WIKI_MCP_URL` at an
   HTTP MCP endpoint.

## Configure (environment variables)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | — | Gemini auth |
| `GEMINI_MODEL` | | `gemini-3.0-pro` | Set to the exact Gemini 3.0 model id you have access to |
| `SEARXNG_URL` | | `http://localhost:8080` | Your SearXNG instance |
| `SEARXNG_MCP_COMMAND` | | `npx` | Command launching the searxng MCP server |
| `SEARXNG_MCP_ARGS` | | `-y mcp-searxng` | Args for that command (space-separated) |
| `LLM_WIKI_MCP_URL` | | — | HTTP MCP endpoint for the knowledge base (takes precedence) |
| `LLM_WIKI_MCP_COMMAND` | | `npx` | Stdio command for the knowledge base MCP server |
| `LLM_WIKI_MCP_ARGS` | | `-y @your-org/llm-wiki-mcp` | Args for that command |

> Adjust `GEMINI_MODEL` to a real id — model availability changes over time, and
> `gemini-3.0-pro` is only a placeholder default.

## Run

```bash
export GEMINI_API_KEY=...                  # required
export SEARXNG_URL=http://localhost:8080   # your SearXNG
# (optionally point LLM_WIKI_MCP_* / SEARXNG_MCP_* at your servers)

bun run examples/ai-assistant/run.ts "What changed in retrieval-augmented generation this year?"
```

Expected output: the assistant streams the tools it calls (`🔧 web_search(...)`),
prints the final answer (`🤖 …`), and a usage snapshot (tokens + tool calls).

## Adapt it

- **Different provider** — implement `LanguageModel` (see `gemini-model.ts` as a template).
- **More MCP servers** — `createMcpToolProvider(name, client)` for each; push into `providers`.
- **Durable memory** — replace `InMemoryMemory` with your own `Memory` (Redis/Postgres/vector).
