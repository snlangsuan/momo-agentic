/**
 * Runnable entrypoint for the Gemini + MCP AI assistant.
 *
 * Configure via environment variables (see examples/ai-assistant/README.md):
 *   GEMINI_API_KEY            (required)
 *   GEMINI_MODEL              (default: gemini-3.0-pro)
 *   SEARXNG_MCP_COMMAND/ARGS  MCP server that wraps a SearXNG instance
 *   SEARXNG_URL               URL of your SearXNG instance
 *   LLM_WIKI_MCP_URL          OR LLM_WIKI_MCP_COMMAND/ARGS for the knowledge base
 *
 * Run with:  bun run examples/ai-assistant/run.ts "your question"
 */
import { type ToolProvider, UsageTracker, combineHooks } from '../../src/index'
import { createAssistant } from './assistant'
import { geminiModel } from './gemini-model'
import { type Client, connectHttpMcp, connectStdioMcp, createMcpToolProvider } from './mcp'

/** Only string env entries, for passing through to a child MCP process. */
function stringEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return { ...env, ...extra }
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY. See examples/ai-assistant/README.md')
    process.exit(1)
  }

  const clients: Client[] = []
  const providers: ToolProvider[] = []

  // 1. searxng MCP — web search.
  const searxng = await connectStdioMcp({
    command: process.env.SEARXNG_MCP_COMMAND ?? 'npx',
    args: (process.env.SEARXNG_MCP_ARGS ?? '-y mcp-searxng').split(' ').filter(Boolean),
    env: stringEnv({ SEARXNG_URL: process.env.SEARXNG_URL ?? 'http://localhost:8080' }),
  })
  clients.push(searxng)
  providers.push(createMcpToolProvider('searxng', searxng))

  // 2. LLM-wiki MCP — knowledge base (HTTP URL or stdio command).
  const wiki = process.env.LLM_WIKI_MCP_URL
    ? await connectHttpMcp(process.env.LLM_WIKI_MCP_URL)
    : await connectStdioMcp({
        command: process.env.LLM_WIKI_MCP_COMMAND ?? 'npx',
        args: (process.env.LLM_WIKI_MCP_ARGS ?? '-y @your-org/llm-wiki-mcp')
          .split(' ')
          .filter(Boolean),
        env: stringEnv(),
      })
  clients.push(wiki)
  providers.push(createMcpToolProvider('llm-wiki', wiki))

  // 3. Wire the assistant: Gemini model + MCP providers + streaming/metering hooks.
  const tracker = new UsageTracker()
  const streamHook = {
    onEvent: (e: { type: string; [k: string]: unknown }) => {
      if (e.type === 'tool_call') console.log(`  🔧 ${e.tool}(${JSON.stringify(e.args)})`)
      if (e.type === 'thinking') console.log(`  💭 ${e.text}`)
    },
  }
  const assistant = createAssistant({
    model: geminiModel({ apiKey, model: process.env.GEMINI_MODEL ?? 'gemini-3.0-pro' }),
    providers,
    hooks: combineHooks(streamHook, tracker.hooks),
  })

  const question =
    process.argv[2] ??
    'What are the latest best practices for prompting LLMs, and any AI news today?'
  console.log(`\n❓ ${question}\n`)

  try {
    const result = await assistant.run(question)
    console.log(`\n🤖 ${result.output}\n`)
    console.log('📊 usage:', tracker.snapshot())
  } finally {
    // Always shut down the MCP child processes / connections.
    await Promise.allSettled(clients.map((c) => c.close()))
  }
}

await main()
