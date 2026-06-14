# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

When releasing, the section for the tagged version is published verbatim as the
GitHub Release notes (see `.github/workflows/release.yml`).

## [Unreleased]

## [0.1.0] - 2026-06-14

Initial release — a layered, provider-agnostic TypeScript library for building
agentic bots, organized along the 8 architectural layers of agentic AI.

### Added

- **Agent orchestrator** — `Agent` (thin orchestrator), `BaseAgent` (prototype for
  custom agents), `IAgent`, `AgentError`, with `maxSteps`, persona/instructions,
  and `RunResult` (output, messages, steps, usage, toolsInvoked, skillsUsed).
- **Layer 4 — Tooling** — `Tool`, `BaseTool`, `defineTool`, `toToolSchema`,
  `ToolRegistry`, and `directReturn` short-circuiting.
- **Layer 4 — Skills** — `Skill`, `defineSkill`, `BaseSkill`, `SkillRegistry`, and
  `skill.md` manifest loading (`parseSkillManifest`, `defineSkillFromManifest`).
- **Layer 5 — Cognition** — `LanguageModel` provider port, optional `Planner`
  routing, and a swappable `ReasoningStrategy` with the default `ReActStrategy`.
- **Layer 6 — Memory** — `Memory` (short-term conversation + long-term facts),
  `InMemoryMemory`, semantic `searchFacts`, `createRememberTool`, and a
  `SummarizingMemory` decorator.
- **Layer 3 — Protocol** — `ToolProvider`, `defineToolProvider`,
  `collectProviderTools` for importing external (MCP-style) tools.
- **Layer 2 — Agent Internet** — `agentAsTool` for multi-agent handoff.
- **Layers 7 + 8 — Observability** — typed `AgentEvent` stream, `AgentHooks`,
  `combineHooks`, and a `UsageTracker` governance hook.
- **Examples** — a runnable example per feature (mock-model based) plus a real
  Gemini 3.0 (`@google/genai`) + MCP (searxng, LLM-wiki) assistant.
- **Docs** — TypeDoc API site with an inline Examples page, deployed to GitHub
  Pages; hand-written `docs/API.md`.
- **Tests & CI** — 49 tests incl. a public-API surface guard and a
  regression/contract suite; CI runs lint + typecheck + tests with JUnit + LCOV
  reports on every push and PR.

[Unreleased]: https://github.com/snlangsuan/momo-agentic/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/snlangsuan/momo-agentic/releases/tag/v0.1.0
