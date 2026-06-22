# Moumantai — codebase rules

Read this before writing code. Subsystem-specific rules live in `<dir>/CLAUDE.md` files that lazy-load when Claude reads files in that subtree — don't restate them here.

## Workflow

1. Pick a clear scope — an open issue, a known cleanup item, or a feature.
2. Read the `spec.md` of every module you depend on (or its source if none exists).
3. Branch from `master`. Pick a topic name; the `{slug}` naming is a convention, not enforced.
4. Write minimal code. Tests verify behavior, not implementation, and are part of the same task — not a separate one.
5. On completion: update `spec.md` if you changed the public contract. The `spec-md-curator` subagent can audit and edit specs.
6. PR title: short, imperative. Body covers what / how to verify / deviations.

**Handoff = spec.md.** A module with a non-trivial public surface gets one. Must contain: **Purpose** (one sentence), **Public API** (signatures + one-line descriptions), **Dependencies**, **Constraints**, **Example** (one happy path). Keep it shorter than the source.

## Contract & type integrity

- **One canonical definition per shared type.** Wire messages, enums, and runtime constants (`DeviceClass`, `VoiceStateValue`, `BinaryFrameType`, `CloseCode`, …) live in `shared/protocol/proto/moumantai/v1/*.proto`; consumers import bindings via `from '@moumantai/protocol/generated/moumantai/v1'`. The only non-generated surfaces are `shared/protocol/src/scope.ts` and `shared/protocol/src/binary-frame.ts`, both re-exported as `@moumantai/protocol`. Never duplicate a type literal union to avoid a cross-package import.
- **Discriminated unions use separate interfaces.** `type X = A | B | C` where each variant is its own interface — never a single interface with optional payload fields (defeats TypeScript narrowing).
- **Dependency direction.** `clients/pwa → shared/protocol` and `server → shared/protocol`. PWA code NEVER imports from `server/`; server code NEVER imports from `clients/pwa/`. The npm-workspace boundary enforces this — check import paths in every PR.
- **Framework-level changes need their own test.** Even a one-line change needs (a) a test proving the new behavior, and (b) a test proving the old behavior still holds.

Protocol-evolution rules (additive only, locked oneof, `[packed=true]`, …) live in `shared/protocol/CLAUDE.md` and lazy-load when working there.

## Testing

| Layer | Tool | Verifies | When |
|---|---|---|---|
| Unit | Vitest | Functions, pure logic, query building | Every module |
| Integration | Vitest | Cross-module workflows (schema → DB → handler) | Every milestone checkpoint |
| E2E | Playwright | Full UI flow through the PWA | When UI is wired |

- Server: unit in `server/tests/unit/`, integration in `server/tests/integration/`, E2E in `server/tests/e2e/` (Python Playwright; `scripts/with_server.py` manages the server lifecycle).
- PWA unit: `clients/pwa/tests/unit/`.
- The test-boundary rule (server tests must not import from `apps/`) and its enforcement script live in `server/CLAUDE.md`.

## Canonical conventions

- **Schema**: Drizzle `sqliteTable()` + `id()`, `timestamps()` from `'moumantai'`.
- **Imports**: `from 'moumantai'`, `from 'moumantai/ui'`, `from 'drizzle-orm'`, `from 'drizzle-orm/sqlite-core'`.
- **Tools**: `defineTool()` with typed Drizzle `db` in `execute()`.
- **Faces**: `defineFace()` with Drizzle queries in `resolve({ db, params })`. Optional `params` declares typed view-state the agent can steer; resolvers fill defaults via `params.x ?? fallback()`. Requires `viewToolDescription` when `params` is declared. The framework auto-synthesizes a `view_<faceId>` tool the LLM uses to update params — **never author a tool with the reserved `view_` prefix**. Components read view-state via `pathRef('/$params/<key>')`.
- **Param boundaries (faces)**: params describe **how** data is shown (filter, slice, focus), never **what** data exists. Mutations stay in tools.
- **Param merge (faces)**: by default each `view_<faceId>` call **replaces** the entire params bag. Multi-dimension filter chips opt into `paramsMerge: 'merge'` on `defineFace` so successive partial calls compose; `null` per-field is the per-dimension reset. Document the merge semantics in `viewToolDescription`.
- **Components**: `list` not `listComponent`, `switchToggle` not `switchComponent`, `progress` not `progressRing`, `select` not `dropdown`.
- **DB**: Drizzle query builder (type-safe), not raw SQL.

## Naming

The codebase is **mixed-case**: wire envelope + component props are camelCase, SQL columns + Drizzle props are snake_case, LLM tool params are snake_case. When adding a new wire field or prop, **match the surrounding case in the file you're editing** rather than starting a new convention.

Pinned (don't move):
- App IDs as wire values: `kebab-case` (`spend-tracker`)
- Face IDs / scope strings as wire values: lowercase
- Env vars: `SCREAMING_SNAKE_CASE`
- Component **type** wire enum values: `PascalCase` (`Text`, `Switch`, `Progress`)

**Kotlin caveat**: don't introduce kotlinx-serialization sealed-class wire polymorphism with `@SerialName(...)` discriminators if a `JsonNamingStrategy` is ever added — the strategy transforms `@SerialName` annotations too ([kotlinx-serialization #3003](https://github.com/Kotlin/kotlinx.serialization/issues/3003)). Today's Kotlin uses plain data classes + `ignoreUnknownKeys = true` — safe.

## Toolchain

Invoke repo-level Python via `uv run python <script>` — never bare `python`/`python3` (bypasses `uv.lock` and the pinned interpreter). ESP-IDF is the exception: use `clients/esp32/tools/run_idf.py` (Windows MSys-friendly), or set `IDF_PY=python tools/run_idf.py`. First-time setup: `task setup` (= `mise install && uv sync`). Per-machine paths in `.mise.local.toml` ← `.mise.local.toml.example`.

## Workspace layout

Each workspace (`server/`, `shared/protocol/`, `clients/<id>/`) owns a `Taskfile.yml`. The `vars:` block is the **SSOT for workspace metadata** (`WORKSPACE_ID`, `WORKSPACE_TYPE`, plus `FORM_FACTOR`/`PLATFORM` for clients); the `tasks:` block declares its commands. The root `Taskfile.yml` includes each under its directory-name namespace. `clients/registry.md` is regenerated from client Taskfiles by `scripts/build-registry.py`.

`apps/` is a git submodule of [`moumantai-apps`](https://github.com/xiang-deng/moumantai-apps) — example plugins live outside the server repo. Clone with `git clone --recurse-submodules`, or run `git submodule update --init` after cloning.

## Git

- Branch from `master`. Never work directly on `master`.
- Commit-message prefixes: `feat:` `fix:` `refactor:` `docs:` `test:` `cleanup:` + concise description.
- Read your own diff before committing.

## Lessons that earned their slot

- **Separate files > branching logic.** Per-device UI = `face.expanded.ts`, `face.parts.ts` — not one file with `if device ==`.
- **Code is truth, docs are claims.** When they disagree, fix the doc — but first verify the code is what you actually want.
- **Verify "dead" before deleting.** "Zero callers" claims have been wrong many times. Grep for usage immediately before delete; let the compiler / tests confirm after.

## Where to go next

| For work in… | Read |
|---|---|
| `server/` | `server/CLAUDE.md` — test boundary, Moumantai Home (`~/.moumantai/`), CLI, hot-reload gotcha |
| `shared/protocol/` | `shared/protocol/CLAUDE.md` + `spec.md` — proto workflow, silent-drop defenses, pre-merge checklist, schema-evolution rules |
| `shared/protocol/design-system/` | `shared/protocol/design-system/CLAUDE.md` — layout recipes, drift prevention; generated `authoring.md` / `rendering.md` |
| `clients/esp32/` | existing `spec.md` — architecture, components, lifecycle |
| Building a new plugin app | Skill: `build-moumantai-app` (auto-invokes on plugin work) — 6-phase TDD workflow + `references/` |
| Plugin app uses upstream data | Skill reference: `external-data-apps.md` — cache-as-DB, resolvers-never-block, 3-tier data model, viewer-app SDK |
| Validating a `.proto` change | Subagent: `protocol-change-validator` — runs the 8-step pre-merge checklist |
| Verifying a `spec.md` after edits | Subagent: `spec-md-curator` — flags drift, can edit specs |
| Workspace orchestration (`task --list-all`) | root `Taskfile.yml` |

