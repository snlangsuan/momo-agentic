import type { Skill } from '@/skill/skill'
/**
 * Load skills from a Markdown manifest with YAML-ish frontmatter (a `skill.md`).
 * This keeps a skill's prose (instruction, description) and metadata out of code
 * and editable by non-engineers. The parser is pure (text in, no filesystem) so
 * it works anywhere; read the file however your runtime prefers, e.g. in Bun:
 *
 * ```ts
 * import md from './skill.md' with { type: 'text' }
 * const skill = defineSkillFromManifest(md, [getWeather])
 * ```
 *
 * Frontmatter keys: `name` (required), `description`, `credit_cost`,
 * `allow_direct_invoke`, `keywords`. The body becomes the skill instruction.
 */
import type { Tool } from '@/tooling/tool'

/** Parsed manifest metadata (without tools). */
export interface SkillManifest {
  name: string
  description: string
  instruction: string
  keywords: string[]
  creditCost: number
  allowDirectInvoke: boolean
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/

/** Coerce a raw frontmatter scalar/array string into a JS value. */
function coerceValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  if (value === 'true' || value === 'false') return value === 'true'
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value)
  return value.replace(/^['"]|['"]$/g, '')
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { meta: {}, body: raw.trim() }

  const [, block = '', body = ''] = match
  const meta: Record<string, unknown> = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = coerceValue(line.slice(colon + 1).trim())
  }
  return { meta, body: body.trim() }
}

/** Parse a `skill.md` manifest's text into {@link SkillManifest} metadata. */
export function parseSkillManifest(raw: string): SkillManifest {
  const { meta, body } = parseFrontmatter(raw)
  const name = typeof meta.name === 'string' ? meta.name : ''
  if (!name) {
    throw new Error('skill manifest is missing a required "name" field in frontmatter')
  }
  return {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    instruction: body,
    keywords: Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [],
    creditCost: typeof meta.credit_cost === 'number' ? meta.credit_cost : 0,
    allowDirectInvoke:
      typeof meta.allow_direct_invoke === 'boolean' ? meta.allow_direct_invoke : true,
  }
}

/** Parse a manifest and combine it with a toolset into a ready {@link Skill}. */
export function defineSkillFromManifest(raw: string, tools: Tool[]): Skill {
  const manifest = parseSkillManifest(raw)
  return {
    name: manifest.name,
    description: manifest.description,
    instruction: manifest.instruction,
    tools,
    keywords: manifest.keywords,
    creditCost: manifest.creditCost,
    allowDirectInvoke: manifest.allowDirectInvoke,
  }
}
