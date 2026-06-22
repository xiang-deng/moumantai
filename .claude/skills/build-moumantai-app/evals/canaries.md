# Regression canaries

Short prompts and expected skill responses. Before shipping a skill edit, verify every canary is still correctly addressed by the current SKILL.md / references.

## Format

```
### C-YYYY-MM-DD-N — one-line description

Scenario: <what triggered the fix>
Category: A | B | C | D (from taxonomy)
Expected skill guidance: <what the skill should say>
Verified in: SKILL.md § <section> | references/<file>.md
```

## Seeded canaries (pre-eval baseline)

### C-2026-04-16-1 — No array/object tool params

Scenario: An LLM author invented `{type: 'array'}` for a tool that takes a list of tags.
Category: A (skill-omission in v0)
Expected skill guidance: "ToolParameter.type is `'string' | 'number' | 'boolean'` only. Pass structured input as JSON string and `JSON.parse` inside execute."
Verified in: SKILL.md § Phase 4 critical pitfalls; references/tools.md.

### C-2026-04-16-2 — Root component id must be "root"

Scenario: Author created `scaffold('main', ...)` on a face and the renderer silently showed nothing.
Category: A
Expected skill guidance: "The root component id MUST be `\"root\"` literally — the renderer expects that string."
Verified in: SKILL.md § Phase 5 critical pitfalls; references/faces.md.

### C-2026-04-16-3 — pathRef has two forms

Scenario: Author used `pathRef('/expense.amount')` inside a list item template; nothing rendered.
Category: A
Expected skill guidance: "Absolute `/a/b` resolves against resolver output; `$.field` inside a list item template resolves against the current row. Mixing them = empty render."
Verified in: SKILL.md § Phase 5; references/faces.md.

### C-2026-04-16-4 — Migration SQL must be committed

Scenario: `apps/<id>/drizzle/` was gitignored; integration test failed on a fresh clone.
Category: C (clear instruction, author ignored it)
Expected skill guidance: "Commit `apps/<id>/drizzle/*.sql` after running `npm run db:generate`. Missing migrations = no tables at boot."
Verified in: SKILL.md § Phase 3 gate.

### C-2026-04-16-5 — ESM .js extensions on local imports

Scenario: `import { manifest } from './manifest'` failed at runtime because Node's ESM loader requires the extension.
Category: A
Expected skill guidance: "Local imports must include `.js` — `from './manifest.js'`, `from './schema.js'`."
Verified in: references/app-structure.md imports cheatsheet.

### C-2026-04-16-6 — skill: field on AppDefinition

Scenario: Generated apps omitted the `skill:` field; LLM lacked domain hint and made wrong tool choices.
Category: A
Expected skill guidance: "Every app sets `skill:` — one sentence of domain context passed to the LLM as system prompt hint."
Verified in: templates/index.ts.tmpl; references/app-structure.md.

### C-2026-04-16-7 — db:generate needs per-app arg

Scenario: Author ran `npm run db:generate` (no args) for the new app; drizzle-kit silently targeted spend-tracker's hardcoded config and printed "No schema changes" with zero migration files for the new app.
Category: A (skill told author to run a command that didn't work)
Expected skill guidance: "Always `npm run db:generate -- <app-id>`. The `-- <app-id>` argument is required — without it, the wrapper defaults to the spend-tracker config."
Verified in: SKILL.md § Phase 3; references/schema.md; scripts/db-generate.ts accepts argv[2].

### C-2026-04-16-8 — Schema placeholder must be deleted

Scenario: Scaffolded `schema.ts` includes `<app_id>_placeholder` table for compilability. Author added their tables without deleting it; generated migration included the placeholder.
Category: A
Expected skill guidance: SKILL.md Phase 3 says "REPLACE (don't extend) the placeholder table". Template has a loud DELETE comment.
Verified in: SKILL.md § Phase 3; templates/schema.ts.tmpl.

### C-2026-04-16-9 — top_bar, trailing_content etc. are snake_case

Scenario: Author wrote `scaffold('root', { topBar: 'top' })`; slot silently didn't render.
Category: A
Expected skill guidance: "Builder function names are camelCase but OPTION keys inside the second argument are snake_case. Use `top_bar`, `trailing_content`, `leading_icon`, `navigation_action`, `horizontal_alignment`."
Verified in: SKILL.md § pitfalls; references/faces.md § 1b.

### C-2026-04-16-10 — Simulator default device is phone, not watch

Scenario: E2E test asserted compact-face text without clicking Watch first; test passed because it was matching expanded-variant text, masking a real bug.
Category: A
Expected skill guidance: "Simulator defaults to PHONE. To test the compact variant, click the Watch device-picker button in `.app-toolbar` first and wait for reconnect."
Verified in: SKILL.md § pitfalls; references/testing.md; templates/e2e.py.tmpl.

## Added in v0.3.0 (code-reviewer pass on diet-tracker r1)

### C-2026-04-16-11 — Tool success examples must show `{ result: ... }` wrapper

Scenario: design-doc-rubric showed `Success: returns { success:true, id }` without the outer `{ result: ... }` wrapper. Author pattern-matches and writes `return { success:true, id }`; tsc fails because `ToolResult` requires `result`.
Category: B (rule stated, but template-for-the-rule was misleading).
Expected skill guidance: Every Success line in the design-doc rubric shows the full `return { result: { ... } }` shape.
Verified in: references/design-doc-rubric.md.

### C-2026-04-16-12 — UTC-vs-local date flakiness in date-dependent tool tests

Scenario: `daily_summary` derives "today" from `toISOString().slice(0,10)` (UTC). Test seeds rows with `Date` objects adjusted via `setHours` (local). At 11pm UTC−5, the two diverge and the assertion fails only on some machines.
Category: B.
Expected skill guidance: testing.md flags this. Use stable ISO strings like `'2026-04-16T12:00:00.000Z'` for fixtures. Don't test day-boundary logic against `new Date()` unless the tool accepts an injected clock.
Verified in: references/testing.md § "Beware UTC vs local date drift".

### C-2026-04-16-13 — RETRACTED (superseded by C-2026-04-17-1)

The v0.3.0 rule "variants must be listed in `faces: [...]`" was reversed in v0.4.0 — registering a variant in the array silently overwrites the default (last-wins). See C-2026-04-17-1 for the current rule. Left as a stub so historical ids stay stable.

### C-2026-04-16-14 — Mutation E2E without LLM key must SKIP, not fake

Scenario: Author without an LLM API key writes an E2E `test_tool_invocation_updates_face` that directly mutates the DB from Python to "prove" the face updates. This proves nothing about the tool path or broadcast.
Category: B.
Expected skill guidance: testing.md is explicit — pick (a) real chat with LLM key, or (b) explicit SKIP with a `print('SKIP: ...')` return. Do NOT simulate via DB write.
Verified in: references/testing.md § "Mutation" caveat.

### C-2026-04-16-15 — Tool filenames are kebab-case, tool `name` values are snake_case

Scenario: Directory-tree in app-structure.md showed `<verb_noun>.ts` (snake-case filename) while the canonical spend-tracker uses `add-expense.ts` (kebab). Author pattern-matches the example but the doc says otherwise.
Category: C (documentation inconsistency).
Expected skill guidance: Tree shows `<verb-noun>.ts` (kebab); tool names inside are snake_case. The two are intentionally different namespaces.
Verified in: references/app-structure.md.

## Added in v0.4.0 (user feedback: multi-face + organization)

### C-2026-04-17-1 — Register only default faces in index.ts faces array

Scenario: Author imports `summaryFaceExpanded` and pushes it into `faces: [summaryFace, summaryFaceExpanded]`. `AppEngine.register()` treats each entry as a default (last-wins); watches end up with the phone variant because expanded was pushed last.
Category: A (skill had the wrong rule through v0.3.0 — the old validator REQUIRED the variant to be in the array).
Expected skill guidance: Only the default (no suffix) goes in `faces: [...]`. Variants are auto-loaded by `scanSupplementalFaces`. Validator in v0.4.0 errors when a variant file is imported AND present in the array.
Verified in: SKILL.md § Phase 5; references/faces.md § "CRITICAL: how to register faces"; apps/diet-tracker/index.ts.

### C-2026-04-17-2 — Per-face subdirectory organization

Scenario: Apps with 3+ faces and 4 files per face (up to 16 files in one flat `faces/` directory) become unreadable; naming prefixes help only up to a point.
Category: A (convention gap).
Expected skill guidance: Each face gets its own subdirectory: `faces/<face-id>/<face-id>.{ts,expanded.ts,resolve.ts,parts.ts}`. Framework patched so `scanSupplementalFaces` recurses one level. `scaffold.sh face` subcommand generates a per-face subdir.
Verified in: references/app-structure.md tree; references/faces.md "The four-file face pattern, per-face subdir"; scripts/scaffold.sh `face` subcommand; server/src/server/agent/app-loader.ts `scanSupplementalFaces` recursion; server/tests/unit/agent/app-loader.test.ts (new subdir tests pass).

### C-2026-04-17-3 — Multi-face by default

Scenario: Author generates a single "summary" face because that's what the rubric example shows. A real app has 2–4 faces (Today / History / Goals). The skill's framing implicitly taught the opposite.
Category: A (framing gap).
Expected skill guidance: SKILL.md "Think in faces" section explains 2D pager navigation; design-doc-rubric shows a 3-face diet-tracker example. A single-face app is rare enough to warrant explicit justification.
Verified in: SKILL.md § "Think in faces"; references/design-doc-rubric.md worked example; references/ux.md.

### C-2026-04-17-4 — App-quality prose (primary action, empty state, size-class thinking)

Scenario: Generated apps pass validator but feel anemic — no empty state, no primary action, "summary" as a face id/label, watch variant is a shrunk phone.
Category: A.
Expected skill guidance: references/ux.md covers navigation, empty states, primary-action patterns per face, resolver-side formatting, user-facing labels ("Today" not "summary"), and the "three questions before shipping a face".
Verified in: references/ux.md.

## Added 2026-06-19 (World Cup edit-agent episode)

### C-2026-06-19-1 — Cache prune must delete children before parents (FK is enforced)

Scenario: A scoreboard refresh task pruned `cache_games` (parent) before `cache_game_detail` (child). schema.md claimed FK pragmas weren't enforced, so the author deleted parent-first. Dormant until rows aged past the 30-day retention window; then every tick threw `FOREIGN KEY constraint failed` at the top of the refresh, silently freezing the whole cache (all leagues, not just the new one).
Category: B (the doc claim "FK not enforced" was wrong and dictated the delete order).
Expected skill guidance: The live per-app DB enforces foreign keys; any multi-table delete removes children before parents. schema.md states FK is ON and shows the child-first cache-prune pattern.
Verified in: references/schema.md § Foreign keys; references/external-data-apps.md § "Cache hygiene: prune order + date bucketing".

### C-2026-06-19-2 — Date bucketing is a product bug, not just a test flake

Scenario: A sports app stored each game's day as `startTime.toISOString().slice(0,10)` (UTC) and the resolver filtered "today" in UTC. Evening North-American kickoffs (after 00:00 UTC) bucketed to the next day and dropped off the "today" tab — a user-visible wrong-day bug, distinct from the CI flakiness in C-2026-04-16-12.
Category: B (the rubric template `date: (UTC)` taught the trap).
Expected skill guidance: Bucket "what day does this record belong to" in the app's display timezone, with the SAME tz at write and read; if upstream groups by a fixed calendar (e.g. ESPN US-Eastern match-day), bucket by that, not UTC. Verify against real upstream data before coding.
Verified in: references/external-data-apps.md § "date bucketing"; references/design-doc-rubric.md (date field comment); references/testing.md.

### C-2026-06-19-3 — Anchor changes to the real implementation; verify external contracts

Scenario: Asked to add a new league, the edit-agent coded against an assumed upstream API shape/slug and an assumed file-naming rule instead of verifying reality — it had no web access to check the actual ESPN contract, and it renamed tool files to satisfy a validator whose demand contradicted the documented kebab convention.
Category: A (skill-omission: no rule to anchor a change to the real implementation; no web tool to verify external contracts).
Expected skill guidance: Before coding, read the actual code/contract you depend on; for upstream APIs use `WebFetch`/`WebSearch` to confirm endpoint/slug, response shape, and edge cases. Code is truth — if a tool or validator contradicts the documented convention or the canonical apps, STOP and flag it rather than contorting code to satisfy it.
Verified in: edit-moumantai-app/SKILL.md § "Core rule — anchor every change to the real implementation"; build-moumantai-app/SKILL.md § "Anchor to real contracts"; references/external-data-apps.md.

### C-2026-04-17-6 — Circular progress needs `label` + `sublabel`, not siblings below

Scenario: Author uses `progress(id, pathRef('/percent'), 100, { variant: 'circular' })` and puts the headline number as a separate `text` sibling. The ring's center is empty whitespace; the number floats below. Visually the ring "doesn't function" — it doesn't communicate what it's tracking.
Category: A (UX guidance gap in v0.4.0).
Expected skill guidance: `references/ux.md` § "The ring pattern that works" shows `label: pathRef(...)` (big number inside) + `sublabel: pathRef(...)` (context line inside). Resolver provides string fields for both.
Verified in: references/ux.md; apps/diet-tracker/faces/today/today.parts.ts + today.resolve.ts.

### C-2026-04-17-7 — Ring with `percent_of_goal = 0` reads as broken

Scenario: When no goal has been set, resolver returns `percent_of_goal: 0`. The circular progress draws a grey track with no colored arc — looks like the component is broken.
Category: A.
Expected skill guidance: When the semantic value is "unset" (not "0% complete"), return `percent_of_goal: 100` so the ring is fully drawn, and convey the "unset" meaning in the sublabel ("no goal set").
Verified in: references/ux.md; apps/diet-tracker/faces/today/today.resolve.ts.

### C-2026-04-17-5 — Description apostrophes break scaffolded manifest

Scenario: `scaffold.sh` substitutes `__APP_DESC__` into a single-quoted TS string in `manifest.ts.tmpl`. A description containing `today's` produces `'Log meals; see today's calories'` — broken TS.
Category: D (template defect).
Expected skill guidance: manifest template uses double-quoted string for `description`.
Verified in: templates/manifest.ts.tmpl.
