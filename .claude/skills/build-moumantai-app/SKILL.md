---
name: build-moumantai-app
description: Build a new Moumantai mini app plugin end-to-end (design doc → Drizzle schema → TDD tools → Moumantai UI faces with size-class variants → Playwright E2E proof). Use when the user asks to create, scaffold, build, or add a new mini app, plugin, or Moumantai app in this repo.
version: 0.5.0
---

# build-moumantai-app

Drive a new Moumantai mini app through the full staff-engineer lifecycle. The skill's value is **phase gates**, not just templates: no business logic before a design doc (and the user's plan approval); every face/tool validated as you write it; no `request_promote_review` until the diff-scoped typecheck + all validators pass. The user previews the result and promotes.

Read `apps/spend-tracker/**`, `apps/diet-tracker/**`, `apps/scoreboard/**`, `apps/todo/**` for canonical examples — they cover the four common face shapes (list, glance/hero, multi-section/filtered, mixed). Everything else you need is in this skill's `references/`. Mini apps are server-side — never cross `client/ ↔ server/` imports.

**Compact screens are first-class.** Every face has TWO variants: `<faceId>.compact.ts` for clients at ≤240dp (currently Wear; also future small peripherals) and `<faceId>.expanded.ts` for wider clients (phone, PWA, and the current 320dp ESP32 panel). The compact variant is NOT a shrunken expanded face — it's a *glance-first* IA with ≤3 visible items, optionally `body_kind: BodyKind.CANVAS` (the `BodyKind` enum from `moumantai/ui` — never a string) for a fixed glance, or the default list for a vertical scroll. Use the `moumantai/ui` patterns (`hero`, `kpi`, `emptyState`, `actionRow`) to compose consistently across faces. See `references/patterns.md`.

**Anchor to real contracts, don't assume.** Copy the framework shape (`defineTool`/`defineFace`/schema/components) from a canonical app — not from memory. When the app integrates an **upstream API**, verify the *real* contract before coding against it: use `WebFetch` to read the API/docs and `WebSearch` to find them, and confirm endpoint/slug, response shape, status codes, and edge cases (especially the **timezone** of timestamps — see `references/external-data-apps.md`). Code is truth; docs and memory are claims that drift.

## Think in faces (the IA that makes an app feel like an app)

The framework's renderer is a **2D pager**: horizontal swipes move between *apps*, vertical swipes move between *faces within an app*. A user's experience of your app is a stack of full-screen, glance-optimized views they swipe through. That shapes the design:

- **One face is almost never enough.** An app with a single "summary" face is a dashboard, not an app. Real apps have a primary view (what the user came for) and 1–3 supporting views (recent history, goals, settings, a detail/add view).
- **Each face has a distinct job** — not "summary plus details" but "Today" vs "History" vs "Goals", each pulling from the same DB through its own resolver, each rendering its own compact + expanded layouts.
- **Faces are cheap.** Four short `.ts` files per face. A 3-face app is ~12 face files, which is why we use per-face subdirs.
- **`position` is the reading order.** 0 is the default view the user lands on. Primary task first.
- **User-facing labels beat engineer-speak.** Face id is `today`, not `summary_face`; label is `"Today"`, not `"Summary"`. Think like the App Store.

Examples of real-app IA (what to aim for):

| App | Faces (position-ordered) |
|---|---|
| Diet tracker | Today → History → Goals |
| Habit tracker | Streaks (today) → Calendar → Goals |
| Reading list | Reading → Finished → To-read |
| Spend tracker (minimal) | Summary (today) → History → Categories |

A single-face app is rare and should be an explicit choice in the design doc, not a default.

## Pinned naming conventions

Enforced by the MCP validators (`validate_face` / `validate_tool` / `validate_types`); the table here is for reading while you design:

| Thing | Style | Example |
|---|---|---|
| App id (manifest + directory) | kebab-case, `/^[a-z][a-z0-9-]*$/`, never `home` | `diet-tracker` |
| Table name | plural snake_case | `meals`, `reading_sessions` |
| Column name | snake_case | `meal_type`, `calories` |
| Tool name | snake_case, verb-first | `add_meal`, `delete_meal`, `daily_summary` |
| Face id | singular | `summary`, `today` |
| Face variant file | `<faceId>.{compact\|expanded}.ts` (explicit) | `today.compact.ts`, `today.expanded.ts` |
| Component id (in a face) | snake_case, stable | `total_label`, `recent_list`, `meal_row` |
| Factory export | `create<PascalName>Def` | `createDietTrackerDef` |

## How you run (read this first)

You run as the **build-agent** inside a **draft worktree** — your cwd — a sandbox that **already contains a generic skeleton** (`index.ts` with the factory + ESM idiom, `manifest.ts` with placeholder fields, `schema.ts`, and empty `tools/`/`faces/`/`drizzle/`). Your job is to **fill it in**, not scaffold from scratch.

- You can WRITE only inside your cwd. There is **no Bash for `npm` / `scaffold.sh` / tests** and no writing outside the draft.
- Validation is via the MCP tools: **`validate_face`**, **`validate_tool`**, **`validate_types`**, **`generate_migration`**, **`request_promote_review`**.
- Other apps are READ-only under `<home>/apps-src/` — read `spend-tracker`, `diet-tracker`, `scoreboard`, `todo` for the canonical idioms and match their style.
- The user previews your draft and decides Promote / Discard. **You never promote.**
- This skill's `templates/` dir holds the canonical file shapes — read them when authoring.

## The workflow

### Phase 1 — Design + plan gate

Author `design.md` (from `templates/design.md.tmpl`) before writing logic. Contents:

1. **Product brief** — one-sentence pitch + 3–5 user stories.
2. **Data model** — table list with columns; justify each by a user story.
3. **Tool inventory** — for each tool: `{name, purpose, params, success criterion}`. Orphan tool = smell.
4. **Face inventory** — for each face: `{id, purpose, resolver output shape, target size classes, variant files needed}`. **The resolver shape IS the contract.**
5. **Size-class plan** — compact (default) is mandatory; add `*.expanded.ts` for phones where useful.
6. **Test plan** — one integration case per tool + per face resolver; E2E cases (launcher, compact-renders, variant-renders, mutation-visible).

See [design-doc-rubric.md](references/design-doc-rubric.md) — load before writing the design doc.

**Gate**: `design.md` covers all six sections.

**Plan-approval gate (STOP here).** After writing `design.md`, reply in the dev
chat with a short plan the user can actually review — the app's one-line pitch,
the faces (with size variants), the tools, the data model, and anything
external (APIs/keys) — then **end your turn**. Do NOT scaffold or write any
`.ts` until the user confirms; they may want to adjust scope first, and building
all six phases is a long, expensive turn to redo. On the next turn (you have
full context via session resume) proceed to Phase 2 if they approved, or revise
`design.md` per their feedback and re-present. This mirrors the edit-agent's
"plan first, then confirm" rule — app creation is always non-trivial, so the
gate is unconditional here.

### Phase 2 — Manifest + entry

The skeleton's `manifest.ts` has placeholder fields — set `id` (kebab-case, the id from your approved plan), `name`, `icon` (a material-symbols name), `description`; keep `version`. The skeleton's `index.ts` already has the factory (`createAppDef`) + ESM idiom; as you author tools and faces, import each and append it to `tools: [...]` / `faces: [...]` (DEFAULT face per id only — variants auto-load). See [app-structure.md](references/app-structure.md).

### Phase 3 — Schema + migration

**REPLACE** the placeholder table in `schema.ts` with your real tables (see [schema.md](references/schema.md)). Then call **`generate_migration`** (the MCP tool — runs drizzle-kit and applies the migration to your shadow DB). Inspect the result with `sqlite3 -readonly .shadow/db.sqlite ".schema <table>"`. **Schema FIRST, then the code that uses the columns** — otherwise `validate_*` reports "Column 'X' not found".

### Phase 4 — Tools

Write each `tools/<verb-noun>.ts` with `defineTool()` (typed Drizzle `db` in `execute`, `{ result, error? }` return; see [tools.md](references/tools.md) for the `ToolParameter.type` union and the `as` cast on `params`). After each tool, call **`validate_tool({ tool_name })`**.

### Phase 5 — Faces

Once per face in the design. Create `faces/<id>/<id>.compact.ts`, `<id>.expanded.ts`, `<id>.parts.ts`, `<id>.resolve.ts` following this skill's `templates/face.*.tmpl` (and the `apps-src/` examples). Then:

- The resolver is a pure `({ db, params }) => object` — its shape IS the contract.
- `body_kind` is the `BodyKind` enum from `moumantai/ui`, never a string.
- Register **ONLY the default (compact)** face id in `index.ts` — the framework's file scan auto-loads the `.expanded` variant.
- After each face, call **`validate_face({ face_id })`**.

See [faces.md](references/faces.md) (pathRef forms, root id, snake_case props, default-only registration) and [ux.md](references/ux.md) (ring anti-pattern, primary actions, empty states).

### Phase 6 — Typecheck, then request review

- Run **`validate_types`** to catch type errors across the files you changed. It is **strict** (`noUncheckedIndexedAccess`, `noUnusedLocals`, …): array access is possibly-`undefined` — handle it; remove unused imports.
- When everything passes → **`request_promote_review({ summary })`** (re-runs every validator + the typecheck as the final gate). Cover in the summary: what was built, any migrations, any refresh tasks, and **any new secrets the user must add to `.env`** after promote (you can't read/write `.env`). If it returns errors, fix and call again. The user promotes — not you.

## Rules

- **Enum props are the enum, never a string/null** (`body_kind: BodyKind.CANVAS`).
- **NEVER** use `as any` / `@ts-ignore` / `@ts-nocheck`, and **never stub `moumantai`** types, to silence a gate — fix the real type. (Tests are not authored in the draft in v1; the validators + typecheck are the correctness gate.)
- If a `validate_*` call fails **3 times in a row on the same target**, STOP retrying — end your turn with a clear explanation and ask the user for guidance.

## Reference index

Load a reference **before** you start the phase it covers.

- [app-structure.md](references/app-structure.md) — load before Phase 2. Directory tree, factory pattern, ESM `__dirname` idiom, the `skill:` field, imports whitelist, `.js` extension rule.
- [schema.md](references/schema.md) — load before Phase 3. Drizzle + `id()`/`timestamps()`, migration flow.
- [tools.md](references/tools.md) — load before Phase 4. Canonical source for `ToolParameter.type` narrow union, `params` casts, return shape, Drizzle idioms.
- [faces.md](references/faces.md) — load before Phase 5. Canonical source for `pathRef` two forms, root id, snake_case prop keys, default-only registration, size-class dispatch.
- [ux.md](references/ux.md) — load before designing any face. 2D-pager implications, primary actions, empty states, the ring pattern, resolver-side formatting, watch-vs-phone discipline.
- [design-doc-rubric.md](references/design-doc-rubric.md) — load before Phase 1. Required sections and the diet-tracker worked example.
- [component-catalog.md](references/component-catalog.md) — load when picking components. Generated from `protocol/catalog.ts`; every Moumantai UI component with signature and device support.
- [external-data-apps.md](references/external-data-apps.md) — load before Phase 1 when the design uses third-party APIs, hardware sensors, or any upstream system. The 3 rules (cache-as-DB, resolvers never block, coherence guarantee), the 3-tier data model, and the viewer-app SDK additions (`defineRefreshTask`, `ctx.http`, `ctx.cacheAsset`, `ctx.staleness`).

