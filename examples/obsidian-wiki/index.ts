/**
 * Use obsidian-llm-wiki (https://github.com/2233admin/obsidian-llm-wiki) — an
 * Obsidian vault exposed as an MCP server — as a knowledge base for an agent.
 *
 * obsidian-llm-wiki speaks **stdio MCP** only, so to reach it as a networked
 * service we run it behind a stdio→HTTP bridge (supergateway / mcp-proxy) in
 * Docker (see docker-compose.yml) and connect over Streamable HTTP here. The MCP
 * tools (vault.search, vault.backlinks, vault.graph, ...) become agent tools via
 * the same `ToolProvider` adapter used for any MCP server.
 *
 * Env:
 *   WIKI_MCP_URL        http(s) URL of the bridged wiki MCP (required)
 *   WIKI_MCP_TRANSPORT  'http' (default, Streamable HTTP) | 'sse' (legacy)
 *   GEMINI_API_KEY      optional — set to actually chat; otherwise just lists tools
 *
 * Run with:  WIKI_MCP_URL=http://localhost:8000/mcp bun run examples/obsidian-wiki/index.ts "your question"
 */
import { Agent } from '../../src/index'
import { geminiModel } from '../ai-assistant/gemini-model'
import { connectHttpMcp, connectSseMcp, createMcpToolProvider } from '../ai-assistant/mcp'

const url = process.env.WIKI_MCP_URL
if (!url) {
  console.error('Missing WIKI_MCP_URL. Start the wiki service (see docker-compose.yml), e.g.:')
  console.error('  docker compose -f examples/obsidian-wiki/docker-compose.yml up -d obsidian-wiki')
  console.error('  WIKI_MCP_URL=http://localhost:8000/mcp bun run examples/obsidian-wiki/index.ts')
  process.exit(1)
}

const client =
  process.env.WIKI_MCP_TRANSPORT === 'sse' ? await connectSseMcp(url) : await connectHttpMcp(url)
const provider = createMcpToolProvider('obsidian-wiki', client)

try {
  // Connection sanity check: list the tools the wiki MCP exposes.
  const tools = await provider.listTools()
  console.log(
    `Connected — obsidian-wiki exposes ${tools.length} tools:`,
    tools.map((t) => t.name),
  )

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.log('\n(connection OK) Set GEMINI_API_KEY to chat with the wiki.')
  } else {
    const agent = new Agent({
      name: 'wiki-assistant',
      model: geminiModel({ apiKey, model: process.env.GEMINI_MODEL ?? 'gemini-3.0-pro' }),
      instructions:
        'Answer from the Obsidian wiki tools. Cite the note titles/paths you used. If the vault has no answer, say so plainly — do not guess.',
      toolProviders: [provider],
      hooks: {
        onEvent: (e) => {
          if (e.type === 'tool_call') console.log(`  🔧 ${e.tool}(${JSON.stringify(e.args)})`)
        },
      },
    })
    const question =
      process.argv[2] ?? 'Summarize the key concepts in my vault and list their backlinks.'
    console.log(`\n❓ ${question}\n`)
    const result = await agent.run(question)
    console.log(`🤖 ${result.output}`)
  }
} finally {
  await client.close()
}
