/**
 * Assembles the AI assistant from momo-agentic layers:
 * - Cognition: a Gemini {@link LanguageModel}
 * - Protocol: MCP tool providers (searxng web search, LLM-wiki knowledge base)
 * - Memory: in-process conversation + facts, with an auto `remember_fact` tool
 * - Observability: hooks for streaming + usage metering
 */
import {
  Agent,
  type AgentHooks,
  InMemoryMemory,
  type LanguageModel,
  type ToolProvider,
} from '../../src/index'

const INSTRUCTIONS = `You are a helpful AI assistant with access to external tools via MCP.

Tool routing:
- For anything CURRENT or factual that changes over time (news, weather, prices,
  releases, "today", "latest"), use the searxng web-search tools and cite the
  source titles/URLs you used.
- For questions about LLMs, prompting, model behavior, or AI engineering, consult
  the LLM-wiki knowledge-base tools first.
- If both apply, gather from the wiki then verify currency with web search.

Answer concisely in the user's language. Do not invent sources or URLs.`

export interface AssistantOptions {
  model: LanguageModel
  providers: ToolProvider[]
  hooks?: AgentHooks
}

export function createAssistant(options: AssistantOptions): Agent {
  return new Agent({
    name: 'assistant',
    model: options.model,
    instructions: INSTRUCTIONS,
    toolProviders: options.providers,
    memory: new InMemoryMemory(),
    rememberFacts: true, // let the model remember user preferences across turns
    factRecallLimit: 8,
    hooks: options.hooks,
    maxSteps: 6,
  })
}
