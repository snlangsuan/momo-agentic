/**
 * Layer 4 — Tooling (Skills).
 *
 * A Skill is a higher-level capability: a named bundle of {@link Tool}s plus an
 * instruction fragment that is injected into the system prompt while the skill
 * is available, and optional metadata (keywords, credit cost) for routing and
 * metering. Skills compose tools the way tools compose functions — register a
 * skill and the agent gains all its tools and its guidance at once.
 */
import type { Tool } from '@/tooling/tool'

/** A named bundle of tools + a prompt fragment + metadata. */
export interface Skill {
  name: string
  description: string
  /** Guidance injected into the system prompt while this skill is available. */
  instruction: string
  /** Tools this skill provides. */
  tools: Tool[]
  /** Hints for routing/classification (used by a {@link Planner}). */
  keywords?: string[]
  /** Overhead cost charged once per turn when any of the skill's tools is used (for governance). */
  creditCost?: number
  /** When false, a router should not fast-path directly into this skill. Defaults to true. */
  allowDirectInvoke?: boolean
}

/** Configuration accepted by {@link defineSkill}. */
export interface SkillDefinition {
  name: string
  description: string
  instruction: string
  tools: Tool[]
  keywords?: string[]
  creditCost?: number
  allowDirectInvoke?: boolean
}

/**
 * Define a skill from a plain object.
 *
 * @example
 * ```ts
 * const weather = defineSkill({
 *   name: 'weather',
 *   description: 'Look up current weather',
 *   instruction: 'Use get_weather for any weather question; report °C.',
 *   tools: [getWeather],
 *   keywords: ['weather', 'temperature', 'forecast'],
 * })
 * ```
 */
export function defineSkill(definition: SkillDefinition): Skill {
  return {
    name: definition.name,
    description: definition.description,
    instruction: definition.instruction,
    tools: definition.tools,
    keywords: definition.keywords,
    creditCost: definition.creditCost,
    allowDirectInvoke: definition.allowDirectInvoke,
  }
}

/**
 * Prototype base class for authoring skills. Extend it for skills that need
 * internal state or shared helpers; supply `tools` from the subclass.
 */
export abstract class BaseSkill implements Skill {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly instruction: string
  abstract readonly tools: Tool[]
  readonly keywords?: string[]
  readonly creditCost?: number
  readonly allowDirectInvoke?: boolean
}
