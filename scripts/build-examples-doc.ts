/**
 * Generates `docs/examples.md` from the real files in `examples/` so the docs
 * site (TypeDoc → GitHub Pages) carries every example inline and never drifts
 * from the source. Wired into the `docs` script; run manually with:
 *
 *   bun run scripts/build-examples-doc.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** [file (relative to examples/), section title, one-line blurb] */
const ITEMS: Array<[string, string, string]> = [
  ['basic.ts', 'Basic agent', 'A first agent: one tool + memory + a hook.'],
  ['tools.ts', 'Tools', 'All three tool styles, `directReturn`, and `ToolRegistry`.'],
  ['skills.ts', 'Skills', 'Bundle tools into a named skill — in code and from a manifest.'],
  [
    'skill-manifest/index.ts',
    'Skill from a manifest file',
    'Load a skill from a real `skill.md` (Bun text import).',
  ],
  [
    'planner.ts',
    'Planner (routing)',
    'Route a turn: respond / auto / use_tools, with the `plan` event.',
  ],
  [
    'custom-strategy.ts',
    'Custom reasoning strategy',
    'Replace the ReAct loop via a `ReasoningStrategy`.',
  ],
  [
    'custom-agent.ts',
    'Custom agent',
    'Bespoke orchestration by extending `BaseAgent` (+ `asTool`).',
  ],
  [
    'memory.ts',
    'Memory (short + long term)',
    'Conversation + facts, auto `remember_fact`, `SummarizingMemory`.',
  ],
  [
    'custom-memory.ts',
    'Custom memory backend',
    'Implement the `Memory` port + semantic `searchFacts`.',
  ],
  [
    'tool-provider.ts',
    'Tool providers',
    '`defineToolProvider` / `collectProviderTools` (non-MCP).',
  ],
  ['multi-agent.ts', 'Multi-agent handoff', 'Delegate to a specialist agent with `agentAsTool`.'],
  [
    'company-agents/agents.ts',
    'Company agents — departments & coordinator',
    'Classify a request and route to HR/IT/Account/Admin agents.',
  ],
  [
    'company-agents/index.ts',
    'Company agents — run',
    'Wire reception + departments; route requests to form links.',
  ],
  ['observability.ts', 'Observability', 'Every event type + `combineHooks` + `UsageTracker`.'],
  [
    'errors-and-abort.ts',
    'Errors & abort',
    '`AgentError` stages, `AbortSignal`, and the `maxSteps` guard.',
  ],
  [
    'ai-assistant/gemini-model.ts',
    'AI assistant — Gemini model adapter',
    'A real `LanguageModel` over `@google/genai`.',
  ],
  [
    'ai-assistant/mcp.ts',
    'AI assistant — MCP tool provider',
    'Adapt any MCP server to a `ToolProvider`.',
  ],
  [
    'ai-assistant/assistant.ts',
    'AI assistant — assembly',
    'Wire model + MCP providers + memory + hooks.',
  ],
  ['ai-assistant/run.ts', 'AI assistant — entrypoint', 'Connect MCP servers and run a query.'],
]

/** GitHub-style heading slug, so the index anchors line up with TypeDoc. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

const parts: string[] = [
  '---',
  'title: Examples',
  '---',
  '',
  '# Examples',
  '',
  'A runnable example for every feature. All but the AI-assistant files use a mock',
  'model (no API key, no network). Run any of them with Bun:',
  '',
  '```bash',
  'bun run examples/<name>.ts',
  '```',
  '',
  '## Index',
  '',
  ...ITEMS.map(([file, title]) => `- [${title}](#${slug(title)}) — \`examples/${file}\``),
  '',
]

for (const [file, title, blurb] of ITEMS) {
  const code = readFileSync(join(ROOT, 'examples', file), 'utf8').trimEnd()
  parts.push(
    `## ${title}`,
    '',
    blurb,
    '',
    `Source: \`examples/${file}\``,
    '',
    // 4-backtick fence so any triple backticks inside a file can't break it.
    '````ts',
    code,
    '````',
    '',
  )
}

writeFileSync(join(ROOT, 'docs', 'examples.md'), `${parts.join('\n')}\n`)
console.log(`Wrote docs/examples.md (${ITEMS.length} examples)`)
