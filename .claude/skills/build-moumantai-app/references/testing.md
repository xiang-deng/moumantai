# Testing

> **Draft mode (v1): you do NOT author or run tests here.** The sandbox has no
> Bash for `npm`/Playwright and no writes to `server/tests/`. Correctness is
> gated by the MCP validators (`validate_face`/`validate_tool`) + the diff-scoped
> `validate_types` + `request_promote_review`. This document describes the
> repo's standalone test layers for reference only; ignore its commands while
> working in a draft.

Two layers (repo-level, not run from a draft): **integration** (Vitest, server-side logic through a real engine) and **E2E** (Python Playwright, UI through the PWA).

Canonical examples — read one end-to-end before writing tests:
- `server/tests/integration/invoke-tool-flow.test.ts` — boot engine with the synthetic test-app fixture, migrate, execute tools, assert resolver shape.
- `server/tests/e2e/run_all.py` — E2E harness entry point (uses `scripts/with_server.py`). App-specific E2E tests live in the apps repo.

> Note: app-specific integration tests (`diet-tracker.test.ts`, etc.) and E2E scripts (`test_simulator_boot.py`, `test_diet_tracker.py`) live in the apps repo (`moumantai-apps`), not in this server repo. The boundary rule (server tests must not import from `apps/`) is why: `server/` uses only the synthetic `test-app` fixture from `server/tests/fixtures/test-app/`.

## Integration test — what to assert

- **Tool tests** — after `execute`, assert both the returned `result` shape AND the DB state via a direct Drizzle query. Return-only assertions pass even for no-ops.
- **Resolver tests** — assert the exact shape the design doc declared, not "data is defined." The resolver test IS the contract between the face and its components.
- **Failure cases** — every delete/update tool should have a "not found → returns `{ error }`" test.
- **Registration** — one test asserts `toolRegistry.keys()` and `faceRegistry.list()` match the design inventory.

Avoid:
- Mocking `db`. Use the real `:memory:` SQLite from `AppEngine`.
- Snapshot tests of objects with timestamps or UUIDs.

Run:
```bash
cd server && npm test -- --run tests/integration/<app-id>.test.ts
```

### The UTC-vs-local date trap

Tools that compute "today" use `new Date().toISOString().slice(0, 10)` — UTC. If a test seeds rows with `Date` manipulation in local time, a run at 11pm in UTC−5 can put the fixture's "today" on a UTC date the tool no longer counts as today. Symptoms: test passes on developer machine, fails in CI.

- Seed rows with stable ISO strings: `eaten_at: '2026-04-16T12:00:00.000Z'`.
- Don't assert "today" aggregates unless the tool is parameterized against a fixed date.
- If the tool hard-codes `new Date()`, either inject a clock or test the non-today cases.

## E2E test

Location: `server/tests/e2e/test_<app_id>.py` (Python identifier — underscores, not dashes).

Four cases (scaffolded in Phase 2):

1. **Launcher lists the app** — `.device-panel` contains the display name.
2. **Variant renders (phone default)** — simulator boots on phone; open the app; TopBar title of the `.expanded` variant is visible.
3. **Compact renders** — click the Watch device-picker button in `.app-toolbar`, wait 1s for reconnect, open the app; expected text from the compact variant is visible.
4. **Mutation visible** — invoke a tool; reload/wait; assert the face reflects the new state. See "mutation case rules" below.

Run via:
```bash
bash .claude/skills/build-moumantai-app/scripts/run-e2e.sh <app-id>
```

That wraps `scripts/with_server.py --server "cd server && npm run dev" --port 5174 -- python tests/e2e/test_<app_id>.py`.

### Robust Playwright patterns

- `page.wait_for_load_state('networkidle')` after every `page.goto`.
- Add `page.wait_for_timeout(2000)` after networkidle for the WS-driven surface.
- `expect(locator).to_contain_text(...)` with generous timeouts (5s+).
- Assert on visible text, not DOM structure.

### Mutation case rules

There is no lightweight HTTP tool-invocation endpoint today. Two options:

1. **LLM API key configured** → drive via the web chat. Type a natural-language request, poll for the text change, 10s+ timeouts.
2. **No LLM key** → **skip the case explicitly**: `print('SKIP: ...')`, return. Do not fake-pass. Do not mutate the DB directly from the E2E — it proves nothing about the tool or the broadcast path.

The integration test already covers the tool logic; the E2E mutation case is UI proof, and UI proof without a real invocation is worse than none.

## Relationship between layers

- Integration proves server logic (DB + tools + resolver). Does not prove UI.
- E2E proves the UI reflects server state through the full stack.
- Both mandatory. Passing integration + failing E2E is usually a `pathRef` mismatch. Passing E2E + failing integration almost never happens; if it does, the E2E is too permissive.

## Source of truth

- `server/tests/integration/invoke-tool-flow.test.ts` — canonical integration test shape (uses synthetic test-app fixture).
- `server/tests/fixtures/test-app/index.ts` — the synthetic `AppDefinition` used by server-side framework tests.
- `server/tests/e2e/run_all.py` — E2E harness entry point.
- `scripts/with_server.py` — start/wait/teardown harness.
- `.claude/skills/build-moumantai-app/scripts/run-e2e.sh`, `run-integration.sh` — thin wrappers.
