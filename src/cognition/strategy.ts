import type { AgentHooks } from '../observability/hooks'
/**
 * Layer 5 — Cognition (reasoning core).
 *
 * A ReasoningStrategy owns the decision loop: model ⇄ tools ⇄ model until a
 * final answer. Extracting it from the Agent keeps the agent a thin orchestrator
 * (Single Responsibility) and lets users swap the reasoning algorithm (ReAct,
 * plan-and-execute, reflexion, ...) without touching memory/hooks/persistence.
 */
import { type Message, type Usage, addUsage, emptyUsage } from '../shared/types'
import { type Tool, type ToolContext, toToolSchema } from '../tooling/tool'
import type { LanguageModel } from './model'

/** Everything a strategy needs to run one turn. */
export interface ReasoningInput {
  agentName: string
  model: LanguageModel
  tools: Tool[]
  /** Working transcript; the strategy appends assistant/tool messages to it. */
  messages: Message[]
  maxSteps: number
  toolContext: ToolContext
  hooks?: AgentHooks
  signal?: AbortSignal
}

/** Result of a completed reasoning turn. */
export interface ReasoningResult {
  output: string
  messages: Message[]
  steps: number
  usage: Usage
  /** Names of tools invoked this turn, in call order (with repeats). */
  toolsInvoked: string[]
}

/** Pluggable reasoning algorithm port. */
export interface ReasoningStrategy {
  readonly name: string
  run(input: ReasoningInput): Promise<ReasoningResult>
}

/** Serialize args deterministically for the loop-guard signature. */
function callSignature(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = args[k]
      return acc
    }, {})
  return `${name}:${JSON.stringify(sorted)}`
}

function stringifyResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result)
}

/** Pull a user-facing string out of a `directReturn` tool result. */
function extractDirectMessage(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'message' in result) {
    const msg = (result as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
  }
  return stringifyResult(result)
}

/**
 * The classic ReAct loop: reason → act (tool calls) → observe → repeat, bounded
 * by `maxSteps`. Includes error handling the cognition layer is responsible for:
 * a hard step cap, an immediate-repeat tool guard (anti-tight-loop), and
 * per-tool error capture so one failing tool never aborts the turn.
 */
export class ReActStrategy implements ReasoningStrategy {
  readonly name = 'react'

  async run(input: ReasoningInput): Promise<ReasoningResult> {
    const { model, tools, messages, maxSteps, toolContext, hooks, signal } = input
    const schemas = tools.map(toToolSchema)
    const byName = new Map(tools.map((t) => [t.name, t]))
    const usage = emptyUsage()
    const toolsInvoked: string[] = []
    let lastStepSignatures = new Set<string>()
    let steps = 0

    while (steps < maxSteps) {
      steps++
      const response = await model.generate({ messages, tools: schemas, signal })
      addUsage(usage, response.usage)

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })

      if (response.content) {
        await hooks?.onEvent?.({ type: 'thinking', agent: input.agentName, text: response.content })
      }

      const toolCalls = response.toolCalls ?? []
      if (toolCalls.length === 0) {
        return { output: response.content, messages, steps, usage, toolsInvoked }
      }

      const currentSignatures = new Set<string>()
      for (const call of toolCalls) {
        toolsInvoked.push(call.name)
        const tool = byName.get(call.name)
        await hooks?.onEvent?.({
          type: 'tool_call',
          agent: input.agentName,
          tool: call.name,
          args: call.arguments,
        })

        const result = await this.executeOne(
          call,
          tool,
          toolContext,
          currentSignatures,
          lastStepSignatures,
        )
        await hooks?.onEvent?.({
          type: 'tool_result',
          agent: input.agentName,
          tool: call.name,
          result: result.value,
        })

        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: result.text,
        })

        if (tool?.directReturn) {
          const output = extractDirectMessage(result.value)
          return { output, messages, steps, usage, toolsInvoked }
        }
      }
      lastStepSignatures = currentSignatures
    }

    // Hit the step cap: surface the last assistant text we have.
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)
    return { output: last?.content ?? '', messages, steps, usage, toolsInvoked }
  }

  private async executeOne(
    call: { name: string; arguments: Record<string, unknown> },
    tool: Tool | undefined,
    toolContext: ToolContext,
    currentSignatures: Set<string>,
    lastStepSignatures: Set<string>,
  ): Promise<{ value: unknown; text: string }> {
    if (!tool) {
      const value = { error: `Unknown tool "${call.name}"` }
      return { value, text: stringifyResult(value) }
    }

    const signature = callSignature(call.name, call.arguments)
    // Anti-tight-loop: refuse an identical call repeated from the previous step.
    if (lastStepSignatures.has(signature) || currentSignatures.has(signature)) {
      const value = {
        error: `Tool "${call.name}" was already called with identical arguments; repeat blocked to avoid loops.`,
      }
      return { value, text: stringifyResult(value) }
    }
    currentSignatures.add(signature)

    try {
      const value = await tool.execute(call.arguments, toolContext)
      return { value, text: stringifyResult(value) }
    } catch (error) {
      const value = { error: error instanceof Error ? error.message : String(error) }
      return { value, text: stringifyResult(value) }
    }
  }
}
