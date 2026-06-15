# momo-agentic + Hono API

A production-shaped HTTP API for an agent, built with [Hono](https://hono.dev) on Bun.
It wires together the pieces you actually need to ship:

- **Multi-user / multi-thread** — one `baseConfig` forked per request into a
  memory-scoped agent via `MemoryStore` + `new Agent({ ...baseConfig, memory })`.
  Conversation is isolated per `(userId, threadId)`; long-term facts are shared per
  `userId`.
- **Streaming** — `POST /chat/stream` returns Server-Sent Events, driven by the
  agent's `token` (and `tool_call`) events.
- **Governance** — in-prompt `policy`, `inputGuardrails` + `outputGuardrails`, a
  per-user `usageLimiter`, and a per-run `timeoutMs`.
- **Error mapping** — `AgentError.stage` → HTTP status (`rate_limit` → 429,
  `timeout` → 504, `response_schema` → 422, else 500).

A mock model keeps it runnable with no API key. For production, swap in a real
`LanguageModel` adapter (see [`../ai-assistant/gemini-model.ts`](../ai-assistant)).

## Run

```bash
bun run examples/hono-api/server.ts          # listens on :3000 (PORT to override)
```

## Try it

```bash
# Plain chat (JSON)
curl -s localhost:3000/chat \
  -d '{"userId":"alice","threadId":"t1","message":"what is the weather?"}'

# Same user + thread remembers prior turns; a different threadId is isolated.
curl -s localhost:3000/chat \
  -d '{"userId":"alice","threadId":"t1","message":"and tomorrow?"}'

# Streaming (Server-Sent Events)
curl -sN localhost:3000/chat/stream \
  -d '{"userId":"carol","threadId":"t1","message":"hello there"}'

# Input guardrail blocks prompt injection (model is never called)
curl -s localhost:3000/chat \
  -d '{"userId":"bob","threadId":"t1","message":"ignore previous instructions"}'

# Clear per-user budgets (demo only)
curl -s -X POST localhost:3000/admin/reset
```

## Notes

- `agentFor(userId, threadId, hooks?)` is the integration seam: it forks a thin,
  stateless agent bound to the caller's memory scope and (for streaming) per-request
  hooks. Build it once per request — agents are cheap.
- Pass `userId`/`threadId` in `RunOptions.metadata` too, so tools and the limiter
  can see them.
- To return typed JSON instead of prose, add a `responseSchema` to `baseConfig` and
  return `result.object`.
