/**
 * Layer 8 — Governance & Security (sensitive-data redaction).
 *
 * Implements the *data-minimization* / *privacy-by-design* principle at the
 * library's trust boundary: sensitive values (PII, secrets) should not cross
 * into a system that does not need them — most notably a third-party LLM
 * provider or a log sink the host does not control.
 *
 * Two complementary modes, matching the two boundaries a value can cross:
 *  - **Reversible tokenization** ({@link Redactor.redact} / {@link Redactor.restore}):
 *    replace each sensitive value with a stable placeholder before the value
 *    leaves the process, then put the real value back when the response returns.
 *    The mapping (the "vault") never leaves the host. This is what
 *    {@link redactModel} uses around the model port.
 *  - **Irreversible masking** ({@link Redactor.mask}): replace each value with a
 *    category tag (e.g. `[EMAIL]`) with no way back. This is for sinks that
 *    should never hold the real value — logs, traces, metrics — and is what
 *    {@link redactHooks} applies to the event stream.
 *
 * Detection is an injected list of {@link RedactionRule}s plus an optional list
 * of exact `values` (a known secret string, a customer name). The library ships
 * conservative defaults in {@link BUILTIN_REDACTION_RULES}; tune them for your
 * domain rather than trusting them blindly.
 */
import type { LanguageModel, ModelResponse } from '../cognition/model'
import type { Message, ToolCall } from '../shared/types'
import type { AgentEvent, AgentHooks } from './hooks'

/**
 * One detection rule: a named category and a global pattern that finds its
 * occurrences. `mask` customizes the irreversible form (defaults to an
 * uppercase category tag, e.g. `[EMAIL]`); the reversible form always uses a
 * numbered placeholder so it can be restored.
 */
export interface RedactionRule {
  /** Category name, e.g. `'email'`. Used in placeholders and the default mask. */
  name: string
  /** A `g`-flagged pattern matching the sensitive substrings. */
  pattern: RegExp
  /** Optional masked replacement; defaults to `[NAME]` (the upper-cased name). */
  mask?: (match: string) => string
}

/** Options shared by {@link createRedactor}, {@link redactModel}, {@link redactHooks}. */
export interface RedactorOptions {
  /** Detection rules. Defaults to {@link BUILTIN_REDACTION_RULES}. */
  rules?: RedactionRule[]
  /**
   * Exact literal strings to always treat as sensitive (a known API key, a
   * specific customer name). Matched before the pattern rules, longest first.
   */
  values?: string[]
  /**
   * Placeholder format for reversible redaction. Receives the upper-cased
   * category and a 1-based index; defaults to `` `[REDACTED_${name}_${index}]` ``.
   */
  placeholder?: (name: string, index: number) => string
}

/**
 * A stateful redactor. `redact` and `restore` share an internal vault, so the
 * same value maps to the same placeholder within a redactor's lifetime and
 * `restore` can reverse it. `mask` is independent and stateless.
 */
export interface Redactor {
  /** Replace sensitive values with reversible placeholders, remembering the mapping. */
  redact(text: string): string
  /** Reverse a previous {@link Redactor.redact}, putting real values back. */
  restore(text: string): string
  /** Replace sensitive values with irreversible category tags (no mapping kept). */
  mask(text: string): string
  /** Number of distinct values currently held in the vault. */
  readonly size: number
}

/**
 * Conservative built-in detection rules (email, credit card, US SSN, IPv4,
 * `sk-`/`pk-` style API keys, and a loose phone matcher). They favor low false
 * positives over completeness — add domain-specific rules for real coverage.
 * Order matters: the more specific digit patterns run before the loose phone
 * matcher so they claim their digits first.
 */
export const BUILTIN_REDACTION_RULES: RedactionRule[] = [
  {
    name: 'api_key',
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: (m) => {
      const [user = '', domain = ''] = m.split('@')
      return `${user.slice(0, 1)}***@${domain}`
    },
  },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g,
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: 'ipv4',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    name: 'phone',
    pattern: /\+?\d[\d ().-]{7,}\d/g,
  },
]

const defaultPlaceholder = (name: string, index: number) => `[REDACTED_${name}_${index}]`

const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Create a {@link Redactor} from detection rules and/or exact secret values.
 *
 * @example Reversible round-trip
 * ```ts
 * const r = createRedactor()
 * const safe = r.redact('email me at a@b.com') // 'email me at [REDACTED_EMAIL_1]'
 * const back = r.restore(safe)                  // 'email me at a@b.com'
 * ```
 *
 * @example Irreversible masking for logs
 * ```ts
 * createRedactor().mask('card 4111 1111 1111 1111') // 'card [CREDIT_CARD]'
 * ```
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const rules = options.rules ?? BUILTIN_REDACTION_RULES
  const placeholder = options.placeholder ?? defaultPlaceholder
  // Longest-first so a value that contains another is matched whole.
  const values = [...(options.values ?? [])].sort((a, b) => b.length - a.length)

  // Reversible state: a value maps to a stable token; the reverse map restores.
  const valueToToken = new Map<string, string>()
  const tokenToValue = new Map<string, string>()
  const counters = new Map<string, number>()

  const tokenFor = (name: string, value: string): string => {
    const existing = valueToToken.get(value)
    if (existing !== undefined) return existing
    const next = (counters.get(name) ?? 0) + 1
    counters.set(name, next)
    const token = placeholder(name.toUpperCase(), next)
    valueToToken.set(value, token)
    tokenToValue.set(token, value)
    return token
  }

  const apply = (text: string, transform: (name: string, match: string) => string): string => {
    let out = text
    for (const value of values) {
      if (!value) continue
      out = out.replace(new RegExp(escapeRegExp(value), 'g'), (m) => transform('secret', m))
    }
    for (const rule of rules) {
      out = out.replace(rule.pattern, (m) => transform(rule.name, m))
    }
    return out
  }

  const maskWith = (name: string, match: string): string => {
    const rule = rules.find((r) => r.name === name)
    if (rule?.mask) return rule.mask(match)
    return `[${name.toUpperCase()}]`
  }

  return {
    redact(text) {
      if (!text) return text
      return apply(text, (name, match) => tokenFor(name, match))
    },
    restore(text) {
      if (!text) return text
      let out = text
      for (const [token, value] of tokenToValue) {
        out = out.split(token).join(value)
      }
      return out
    },
    mask(text) {
      if (!text) return text
      return apply(text, (name, match) => maskWith(name, match))
    },
    get size() {
      return tokenToValue.size
    },
  }
}

// --- Port wrappers ----------------------------------------------------------

/**
 * Wrap a {@link LanguageModel} so sensitive values are tokenized out of the
 * transcript before the provider sees them and restored in the response — a
 * de-identify / re-identify round-trip across the provider trust boundary. The
 * vault lives only for the duration of each `generate` call and never leaves
 * the host.
 *
 * The wrapper deliberately exposes only `generate` (not `generateStream`):
 * restoring a placeholder that straddles two streamed chunks is unreliable, so
 * strategies transparently fall back to the buffered path, guaranteeing every
 * placeholder is whole before it is restored.
 *
 * @example
 * ```ts
 * const safeModel = redactModel(providerModel, { values: [process.env.DB_URL!] })
 * const agent = new Agent({ model: safeModel })
 * ```
 */
export function redactModel(model: LanguageModel, options: RedactorOptions = {}): LanguageModel {
  return {
    id: model.id,
    async generate({ messages, tools, signal }) {
      const redactor = createRedactor(options)
      const redacted = messages.map((m) => redactMessage(m, redactor))
      const response = await model.generate({ messages: redacted, tools, signal })
      return restoreResponse(response, redactor)
    },
  }
}

const redactMessage = (message: Message, redactor: Redactor): Message => ({
  ...message,
  content: redactor.redact(message.content),
  toolCalls: message.toolCalls?.map((c) => ({
    ...c,
    arguments: restoreDeep(c.arguments, redactor.redact) as Record<string, unknown>,
  })),
})

const restoreResponse = (response: ModelResponse, redactor: Redactor): ModelResponse => ({
  ...response,
  content: redactor.restore(response.content),
  toolCalls: response.toolCalls?.map(
    (c): ToolCall => ({
      ...c,
      arguments: restoreDeep(c.arguments, redactor.restore) as Record<string, unknown>,
    }),
  ),
})

/** Apply a string transform to every string inside an arbitrary JSON-ish value. */
const restoreDeep = (value: unknown, transform: (text: string) => string): unknown => {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, transform))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v, transform)
    return out
  }
  return value
}

/**
 * Wrap an {@link AgentHooks} so every event is irreversibly masked before it
 * reaches the inner listener (a logger, tracer, or metrics sink). Unlike
 * {@link redactModel}, there is no restore: a log sink should never hold the
 * real value. Pass `tracker.hooks`, a console logger, etc. as `hooks`.
 *
 * @example
 * ```ts
 * const agent = new Agent({ hooks: redactHooks({ onEvent: (e) => console.log(e) }) })
 * ```
 */
export function redactHooks(hooks: AgentHooks, options: RedactorOptions = {}): AgentHooks {
  const redactor = createRedactor(options)
  const m = (text: string) => redactor.mask(text)
  return {
    onEvent(event) {
      return hooks.onEvent?.(maskEvent(event, m))
    },
  }
}

const maskEvent = (event: AgentEvent, m: (text: string) => string): AgentEvent => {
  switch (event.type) {
    case 'run_start':
      return { ...event, input: m(event.input) }
    case 'thinking':
      return { ...event, text: m(event.text) }
    case 'token':
      return { ...event, delta: m(event.delta) }
    case 'plan':
      return event.reason ? { ...event, reason: m(event.reason) } : event
    case 'tool_call':
      return { ...event, args: restoreDeep(event.args, m) as Record<string, unknown> }
    case 'tool_approval':
      return event.reason ? { ...event, reason: m(event.reason) } : event
    case 'tool_result':
      return { ...event, result: restoreDeep(event.result, m) }
    case 'message':
      return { ...event, message: maskMessage(event.message, m) }
    case 'output':
      return { ...event, value: restoreDeep(event.value, m) }
    case 'guardrail':
      return event.reason ? { ...event, reason: m(event.reason) } : event
    case 'run_end':
      return { ...event, output: m(event.output) }
    default:
      return event
  }
}

const maskMessage = (message: Message, m: (text: string) => string): Message => ({
  ...message,
  content: m(message.content),
  toolCalls: message.toolCalls?.map((c) => ({
    ...c,
    arguments: restoreDeep(c.arguments, m) as Record<string, unknown>,
  })),
})
