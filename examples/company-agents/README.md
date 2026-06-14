# Example: company multi-agent (classify → route → tool)

A reception/coordinator agent that classifies an employee request and delegates
to the right **department agent** (HR / Account / IT / Admin). The department
agent then picks the appropriate **tool** (a company-wiki lookup) and returns the
form link.

```
employee ──▶ reception ──classify──▶ hr-agent ──wiki_lookup──▶ HR headcount form
                                     account-agent             Expense form
                                     it-agent                  IT support form
                                     admin-agent               Room booking form
```

Example: `"อยากได้ฟอร์มขอรับพนักงานเพิ่ม"` → reception routes to `hr_agent` →
hr-agent calls `wiki_lookup` → replies with the **Headcount Request** form link.

## How it maps to momo-agentic

| Piece | Library feature |
| --- | --- |
| Department agents (HR/Account/IT/Admin) | one `Agent` each, with their own tools |
| "an agent is also a tool" | `agentAsTool(deptAgent, { name, description })` (Layer 2) |
| Coordinator picks a department | the coordinator model calls the matching department tool (classify + handoff) |
| Department picks the right tool | the department agent's reasoning loop calls `wiki_lookup` |
| Company wiki | a `Tool` (here in-memory; swap for RAG/MCP) |
| Tracing the chain | `AgentHooks` `tool_call` events |

## Files

```
wiki.ts     in-memory form knowledge base + wiki_lookup tool (per department)
agents.ts   department agents + the coordinator (mock models: classify & reply)
index.ts    wires reception + departments, runs sample requests
```

## Run

```bash
bun run examples/company-agents/index.ts
```

## Make it real

- Replace the mock models in `agents.ts` with a real `LanguageModel`
  (see [../ai-assistant/gemini-model.ts](../ai-assistant/gemini-model.ts)) — then
  classification and replies are done by the LLM instead of keyword tables.
- Replace `wiki_lookup` with a real knowledge-base tool, e.g. an MCP server
  (see [../ai-assistant/mcp.ts](../ai-assistant/mcp.ts)).
- Add per-department tools (create ticket, submit form, check status, ...).
