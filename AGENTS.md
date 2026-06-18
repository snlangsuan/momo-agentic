# AGENTS.md

แนวทางสำหรับ AI agents (เช่น Codex) ที่ทำงานกับ repo นี้

## ภาพรวมโปรเจค

`momo-agentic` เป็น **library (ไม่ใช่ application)** เขียนด้วย TypeScript สำหรับให้
ผู้ใช้นำไปสร้าง **agentic bot** ของตัวเอง

หลักการออกแบบ:

- **Provider-agnostic** — library ไม่ผูกกับผู้ให้บริการ LLM รายใดรายหนึ่ง ผู้ใช้ inject
  โมเดลเข้ามาผ่าน interface `LanguageModel` (ดู [src/types.ts](src/types.ts)) เพราะฉะนั้น
  **อย่าเพิ่ม dependency ของ vendor SDK ใด ๆ ลงใน core** ถ้าจะทำ adapter ให้แยกไว้ต่างหาก
- **Zero runtime dependencies** — core ตั้งใจให้ไม่มี runtime dependency ก่อนเพิ่มต้องมีเหตุผลชัดเจน
- **API เล็กและชัด** — ผิวสัมผัสหลักคือ `Agent`, `defineTool`, และ type `LanguageModel`

## Runtime & Toolchain

- **Runtime / package manager / test runner / bundler: [Bun](https://bun.sh) 1.2+** — ใช้ `bun` ไม่ใช่ `npm`/`node`
- ภาษา: TypeScript (strict mode)
- Lint + format: **Biome** (เครื่องมือเดียว) — ดู [biome.json](biome.json)
- Build: `bun build` สำหรับ JS (ESM + CJS) + `tsc` สำหรับ `.d.ts`

## คำสั่งที่ใช้บ่อย

```bash
bun install          # ติดตั้ง dependencies
bun test             # รัน test (ไฟล์ *.test.ts ด้วย bun:test)
bun test --watch     # test แบบ watch
bun run typecheck    # ตรวจ type ด้วย tsc --noEmit (ไม่ emit ไฟล์)
bun run lint         # ตรวจด้วย biome
bun run format       # จัด format ด้วย biome
bun run check        # format + typecheck + test (รันก่อน commit)
bun run build        # build ลง dist/
bun run docs         # gen HTML API docs (TypeDoc) ลง ./site (gitignored, CI deploy ขึ้น Pages)
bun run examples/basic.ts   # รันตัวอย่าง
```

## เอกสาร
- [README.md](README.md) คู่มือใช้งาน + guides, [docs/API.md](docs/API.md) API reference เขียนมือ
- TypeDoc gen จาก TSDoc comment → `./site` (อย่า commit, อยู่ใน .gitignore) deploy อัตโนมัติผ่าน [.github/workflows/docs.yml](.github/workflows/docs.yml)
- หน้า Examples ในเว็บ docs สร้างจาก [scripts/build-examples-doc.ts](scripts/build-examples-doc.ts) → `docs/examples.md` (generated, gitignored) แล้ว TypeDoc include เป็น document page; เพิ่ม example ใหม่ → เพิ่มใน ITEMS ของ script ด้วย
- เขียน `{@link SymbolName}` ใน TSDoc แบบชื่อ symbol ตรง ๆ เท่านั้น (อย่าใช้ `{@link import('...').X}` — TypeDoc resolve ไม่ได้)

## สถาปัตยกรรม — folder-per-layer (อิงทฤษฎี 8 Architectural Layers of Agentic AI)

แต่ละโฟลเดอร์ใน `src/` = 1 layer ของทฤษฎี **ทุก layer เป็น interface (port) ที่ inject ได้
ห้าม hardcode infra ใด ๆ** Layer 1 (Infrastructure) อยู่นอก lib — ผู้ใช้ inject ผ่าน port เหล่านี้

```
src/
  shared/        primitives กลาง: Message, ToolCall, ToolSchema, Usage
  tooling/       L4 Tooling     — Tool, BaseTool (prototype), defineTool, ToolRegistry
  skill/         L4 Tooling(Skills) — Skill, defineSkill, BaseSkill, SkillRegistry, defineSkillFromManifest (skill.md)
                 #   Skill = bundle ของ tools + instruction fragment + metadata · Agent: skills=[...] กาง tools + inject instruction + RunResult.skillsUsed
  cognition/     L5 Cognition   — LanguageModel (model port), Planner, ReasoningStrategy + ReActStrategy
  memory/        L6 Memory      — Memory (short+long term), InMemoryMemory, SummarizingMemory, createRememberTool
                 #   short-term: loadHistory/appendMessage · long-term: rememberFact/recallFacts/searchFacts(semantic)
                 #   Agent: rememberFacts=true เพิ่ม remember_fact tool ให้เขียน fact เอง · factRecallLimit คุมจำนวน fact ที่ inject
  protocol/      L3 Protocol    — ToolProvider (MCP-style external tools), defineToolProvider
  observability/ L7+L8 App+Gov  — AgentHooks/AgentEvent, combineHooks, UsageTracker
  network/       L2 Agent Internet — agentAsTool (multi-agent handoff)
  agent/         orchestrator   — IAgent, BaseAgent (prototype), Agent (thin orchestrator)
  test-support/  ScriptedModel  — helper สำหรับ test (ไม่ ship ใน dist)
  public-api.test.ts  guard: ล็อก export surface (runtime + type) — กันลบ/เปลี่ยนชื่อ export โดยไม่ตั้งใจ
  regression.test.ts  guard: behavioral invariants + integration หลาย feature พร้อมกัน
  index.ts       barrel export — public API ทั้งหมด re-export จากที่นี่
examples/
  basic.ts       ตัวอย่าง: tool + memory + hooks
  multi-agent.ts ตัวอย่าง: lead agent delegate ไป specialist agent
```

### หลักการออกแบบที่ต้องรักษา
- **Agent = orchestrator บาง ๆ** ไม่ถือ algorithm เอง — โยนการ reasoning ให้ `ReasoningStrategy` (แก้ God Object)
- **ทุก dependency เป็น port ที่ inject** — model/memory/planner/hooks/tools ไม่อ้าง concrete infra ตรง ๆ (Dependency Inversion)
- **provider เดียว** ผ่าน `LanguageModel` (ไม่แยกโค้ด openai/gemini — ผู้ใช้เขียน adapter เอง)
- **Tool schema เป็น JSON Schema** เพื่อให้เข้ากับ MCP/OpenAI/Gemini ได้
- เพิ่มความสามารถใหม่ = เพิ่มไฟล์ใน layer ที่ตรง แล้ว re-export ผ่าน `index.ts` ของ layer + barrel

## กติกาสำหรับการแก้โค้ด (สำคัญ)

1. **เพิ่ม public API ใหม่ ต้อง re-export ผ่าน [src/index.ts](src/index.ts)** เสมอ — แล้ว**เพิ่มชื่อใน [src/public-api.test.ts](src/public-api.test.ts)** ด้วย (value ลงใน VALUE_EXPORTS, type ลงใน _PublicTypeSurface). ถ้า**ตั้งใจ**ลบ/เปลี่ยนชื่อ export ให้แก้ guard นี้ใน commit เดียวกัน — ห้ามแก้ guard เพื่อให้ test ผ่านโดยไม่ตั้งใจ
2. **ทุก feature/แก้ bug ต้องมาพร้อม test** ใน `*.test.ts` ที่อยู่ติดกับไฟล์ source — และต้องไม่ทำให้ [regression.test.ts](src/regression.test.ts) (invariants ของเก่า) แดง
3. **รัน `bun run check` ให้ผ่านก่อนถือว่าเสร็จ** (format + typecheck + test ต้องเขียว)
4. ตาม style ของ Biome: single quote, ไม่ใส่ semicolon, trailing comma, กว้าง 100 ตัวอักษร —
   ไม่ต้องจัดเอง ใช้ `bun run format`
5. ใช้ `import type { ... }` สำหรับ type-only import (บังคับโดย `verbatimModuleSyntax`)
6. **อย่า commit โฟลเดอร์ `dist/`** (อยู่ใน `.gitignore` แล้ว) — เป็น build artifact
7. เขียน TSDoc comment บน public API ทุกตัว เพื่อให้ผู้ใช้ library เข้าใจง่าย
8. **เปลี่ยน public behavior/feature ต้องบันทึกใน [CHANGELOG.md](CHANGELOG.md)** ใต้หัวข้อ `## [Unreleased]` (Keep a Changelog: Added/Changed/Fixed/Removed)
9. **Release flow:** bump `version` ใน package.json → ย้าย `[Unreleased]` เป็น `## [x.y.z] - YYYY-MM-DD` → `git tag vX.Y.Z && git push origin vX.Y.Z` → [release.yml](.github/workflows/release.yml) สร้าง GitHub Release + **publish npm** (provenance). tag ต้องตรงกับ version ใน package.json ไม่งั้น workflow fail
10. **ก่อน publish npm ครั้งแรก:** แทน `OWNER` ใน package.json (repository/homepage/bugs) + CHANGELOG ด้วย org/user จริง (repository URL ต้องตรง repo เพื่อ provenance) และตั้ง repo secret `NPM_TOKEN`. แพ็กเกจ ship เฉพาะ `dist/ + README + CHANGELOG + LICENSE` (`files` ใน package.json) — เช็คด้วย `npm pack --dry-run`

## หมายเหตุเรื่องโมเดล

โปรเจคนี้สร้าง LLM application — โมเดลที่แนะนำ default คือตระกูล Codex รุ่นล่าสุด
(เช่น `Codex-opus-4-8`) เมื่อเขียน adapter ตัวอย่างหรือ docs ที่อ้างถึงโมเดล
