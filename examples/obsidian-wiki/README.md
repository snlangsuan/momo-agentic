# Example: obsidian-llm-wiki as a knowledge base (MCP, Dockerized)

Use [obsidian-llm-wiki](https://github.com/2233admin/obsidian-llm-wiki) — your
Obsidian vault compiled into an MCP server (`vault.search`, `vault.backlinks`,
`vault.graph`, …) — as an agent's knowledge base.

obsidian-llm-wiki speaks **stdio MCP only**. There are two ways to use it:

| | How | Connect with |
| --- | --- | --- |
| **A. Co-located** | Spawn the wiki as a child process inside your app | `connectStdioMcp(...)` |
| **B. Service** (this example) | Run the wiki behind a stdio→HTTP bridge in Docker | `connectHttpMcp(url)` |

Either way the wiki's tools become agent tools through the same
[`ToolProvider` adapter](../ai-assistant/mcp.ts).

## How option B works

```
agent app ──HTTP──▶ supergateway (stdio↔HTTP) ──stdio──▶ obsidian-llm-wiki ──▶ /vault
```

`obsidian-llm-wiki` has no HTTP mode, so [supergateway](https://github.com/supercorp-ai/supergateway)
(or [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)) bridges its stdio to
Streamable HTTP, which `connectHttpMcp` speaks.

## The wiki's launch command

Verified from the repo's `.claude-plugin/mcp.json` (server name `vault-mind`):

```json
{ "mcpServers": { "vault-mind": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/bundle.js"],
  "env": {}
}}}
```

So the server is just `node mcp-server/bundle.js` (`bundle.js` is prebuilt and
committed), Node 20+, and it finds the vault from the working directory or
`VAULT_MIND_VAULT_PATH`. The Docker setup below already encodes this — no
placeholder to fill except your **vault path**.

## Setup

1. Put your Obsidian vault at `examples/obsidian-wiki/my-vault` (or edit the
   volume in [docker-compose.yml](docker-compose.yml)).
2. Start the wiki service — [Dockerfile.wiki](Dockerfile.wiki) clones the repo,
   installs deps, and runs it behind supergateway:
   ```bash
   docker compose -f examples/obsidian-wiki/docker-compose.yml up -d --build obsidian-wiki
   ```

## Run

```bash
# List the tools the wiki exposes (proves the connection — no LLM needed):
WIKI_MCP_URL=http://localhost:8000/mcp bun run examples/obsidian-wiki/index.ts

# Chat with the vault (needs a model):
GEMINI_API_KEY=... WIKI_MCP_URL=http://localhost:8000/mcp \
  bun run examples/obsidian-wiki/index.ts "Summarize concept X and its backlinks"

# Or run the whole thing (wiki + app) in Docker:
GEMINI_API_KEY=... docker compose -f examples/obsidian-wiki/docker-compose.yml up
```

| Env | Purpose |
| --- | --- |
| `WIKI_MCP_URL` | URL of the bridged wiki MCP (required) |
| `WIKI_MCP_TRANSPORT` | `http` (default, Streamable HTTP) or `sse` (legacy gateways) |
| `GEMINI_API_KEY` | optional — set to actually chat; otherwise the example just lists tools |

## Notes

- If your bridge only exposes **legacy SSE**, set `WIKI_MCP_TRANSPORT=sse`
  (uses `connectSseMcp`); Streamable HTTP is preferred.
- For **option A** (no Docker, single process), skip the bridge and spawn the
  server directly:
  ```ts
  const wiki = await connectStdioMcp({
    command: 'node',
    args: ['/path/to/obsidian-llm-wiki/mcp-server/bundle.js'],
    env: { VAULT_MIND_VAULT_PATH: '/path/to/vault' },
  })
  const agent = new Agent({ model, toolProviders: [createMcpToolProvider('obsidian-wiki', wiki)] })
  ```
- Mount the vault read-only (`:ro`) unless you want the self-improving wiki to
  write back to it.
- **No native build tools needed.** The wiki's runtime deps are all WASM/pure-JS
  (`@electric-sql/pglite` is WASM, `pg`/`ws`/MCP SDK are pure JS), so the slim
  image builds without `node-gyp`/python/make. The Dockerfile uses
  `--omit=optional` to skip `ws`'s optional native addon.
