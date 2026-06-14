// Skills from a real `skill.md` manifest file (Layer 4). Bun imports the
// Markdown as text via an import attribute; `defineSkillFromManifest` parses the
// frontmatter (metadata) and body (instruction) and attaches your tools.
//
// Run with:  bun run examples/skill-manifest/index.ts

import { Agent, defineSkillFromManifest, defineTool, parseSkillManifest } from '../../src/index'
import { scriptModel } from '../_support/mock-model'
import manifest from './web-search.skill.md' with { type: 'text' }

const searchTool = defineTool<{ query: string }>({
  name: 'search',
  description: 'Search the web',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  execute: ({ query }) => `Top result for "${query}": momo-agentic ships skills.`,
})

// Inspect the parsed metadata...
const meta = parseSkillManifest(manifest)
console.log('Manifest:', { name: meta.name, creditCost: meta.creditCost, keywords: meta.keywords })

// ...and build the skill (metadata + body instruction + your tools).
const webSearch = defineSkillFromManifest(manifest, [searchTool])

const agent = new Agent({
  model: scriptModel([
    {
      content: '',
      toolCalls: [{ id: 'c1', name: 'search', arguments: { query: 'momo-agentic' } }],
    },
    { content: 'Found it — momo-agentic supports skills loaded from manifests.' },
  ]),
  skills: [webSearch],
})

const result = await agent.run('search for momo-agentic')
console.log('Output:', result.output)
console.log('Skills used:', result.skillsUsed)
