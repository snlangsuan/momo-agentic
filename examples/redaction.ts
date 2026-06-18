/**
 * Governance & Security (Layer 8) — sensitive-data redaction.
 *
 * Two trust boundaries, two modes:
 *  - `redactModel` wraps the model port: it TOKENIZES PII out of the transcript
 *    before the (third-party) provider sees it, then RESTORES the real values in
 *    the response. The mapping ("vault") never leaves the process. Reversible.
 *  - `redactHooks` wraps the event stream: it irreversibly MASKS PII before it
 *    reaches a logger/tracer — a log should never hold the real value.
 *
 * Run with:  bun run examples/redaction.ts
 */
import { Agent, type RedactorOptions, redactHooks, redactModel } from '../src/index'
import { fnModel } from './_support/mock-model'

// One detection config, applied at both boundaries: `values` adds an exact
// secret (a known account id) on top of the built-in PII rules.
const redaction: RedactorOptions = { values: ['ACME-9921'] }

// A mock provider that echoes back what it received — so we can SEE that it only
// ever observed the tokenized transcript, never the real email.
const provider = fnModel('mock:provider', (options) => {
  const lastUser = [...options.messages].reverse().find((m) => m.role === 'user')
  console.log('🌐 provider saw:', JSON.stringify(lastUser?.content))
  // The provider replies using the placeholder it was given; the wrapper will
  // swap the real value back in before the agent returns.
  return {
    content: `Done — I emailed the invoice to ${lastUser?.content.match(/\[REDACTED_[^\]]+\]/)?.[0] ?? 'them'}.`,
  }
})

const agent = new Agent({
  // de-identify before the provider, re-identify after.
  model: redactModel(provider, redaction),
  instructions: 'Help the user with billing.',
  // every event is masked before this console logger sees it.
  hooks: redactHooks(
    {
      onEvent: (e) => {
        if (e.type === 'run_start') console.log('📝 log[input]:', e.input)
        if (e.type === 'run_end') console.log('📝 log[output]:', e.output)
      },
    },
    redaction,
  ),
})

const result = await agent.run('Email the invoice for account ACME-9921 to alice@example.com')

// The caller gets the REAL values back — restoration happened inside redactModel.
console.log('✅ answer:', result.output)
