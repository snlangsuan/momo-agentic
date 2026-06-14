import type { Tool } from '../tooling/tool'
import type { Skill } from './skill'

/**
 * A name-keyed collection of skills; last registration of a name wins. Use it to
 * assemble a catalog of capabilities and hand `registry.list()` to an agent.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>()

  /** Register one or more skills. Returns `this` for chaining. */
  register(...skills: Skill[]): this {
    for (const skill of skills) {
      this.skills.set(skill.name, skill)
    }
    return this
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  /** All registered skills, in insertion order. */
  list(): Skill[] {
    return [...this.skills.values()]
  }

  /** Every tool across all registered skills, flattened. */
  tools(): Tool[] {
    return this.list().flatMap((skill) => skill.tools)
  }

  get size(): number {
    return this.skills.size
  }
}
