# External-data apps (viewer-app pattern)

Apps whose data lives upstream — sports, weather, stocks, IoT mirrors, calendar viewers — follow a uniform pattern. Load this reference when the design doc says the app's primary data source is a third-party API, a hardware sensor, or any system the user doesn't directly own.

## Three rules

### Rule 1 — Cache-as-DB (per-table)

Any *table* that mirrors upstream data follows the cache-as-DB pattern: refresh tasks (or upstream-aware tools) fetch and write; **resolvers read**. User-owned tables in the same app are unaffected.

- Use the `cache_*` prefix for upstream-mirrored tables; plain names for user-owned tables.
- Example: a sports app has both `cache_games` (mirror) and `followed_teams` (user-owned).
- Data sources go behind a thin module: `apps/<id>/src/sources/<name>.ts`. Swapping providers becomes a one-file change.

### Rule 2 — Resolvers never block on network

`resolve()` may read DB, config, context, asset store, computed state. It must NOT invoke `fetch()`, third-party SDK calls, or any I/O depending on a remote system.

- Network I/O lives in **tools** (user/LLM-initiated) or **refresh tasks** (cron- or webhook-initiated). Both write to the DB.
- Resolvers read the DB.
- `async resolve` is fine — the rule is about *network*, not the `async` keyword. Cross-app DB reads, config/context reads, and asset URL reads from cached rows are all allowed.
- Failure mode this prevents: slow face renders, network-dependent resolver tests, hidden quota burn on face open, N-device fan-out hits to upstream.

### Rule 3 — Coherence guarantee

All mounted clients of a scope **converge to the same state**.

- While continuously connected, deltas arrive in the same order they were generated.
- Reconnecting clients receive a snapshot reflecting current state.
- The framework does NOT throttle deltas per-client. If a future device genuinely cannot keep pace, slow the *source* (task `nextRun`) so every consumer sees fewer updates equally — never per-client batching, which causes the same scope to disagree with itself across a user's own devices.

## Cache hygiene: prune order + date bucketing

Refresh tasks that mirror upstream data into `cache_*` tables share two recurring correctness traps.

**Prune order — children before parents.** App DBs enforce foreign keys (see `references/schema.md`). A refresh that prunes old rows from a parent table (`cache_games`) while a child table (`cache_game_detail`) still references them throws `FOREIGN KEY constraint failed`. Because pruning typically runs at the TOP of the tick, that error aborts the **entire** refresh — silently freezing the cache for every league/row once data ages past the retention window. Always delete child rows first, then parents.

**Date bucketing — use the display timezone, end to end.** "What day does this record belong to" must be computed in the timezone the app *displays*, and the source-write and resolver-read must use the **same** timezone — otherwise records land on the wrong day.

- `startTime.toISOString().slice(0,10)` gives the **UTC** day. For any event with an evening local start (sports, shows, anything anchored to a fixed non-UTC region), the UTC day rolls past midnight and the record falls off "today." This is a *product* bug, not just the CI flakiness in `references/testing.md`.
- If upstream organizes data by a fixed calendar (e.g. ESPN groups a scoreboard by US-Eastern match-day), bucket by THAT timezone, not UTC. Compute the bucket once at write time and filter by the same convention in the resolver.
- State the chosen timezone in the design doc's data model, and verify it against real upstream behavior (fetch a day's data with `WebFetch`, check which records land where) before coding.

## Three-tier data model

| Tier | Storage | LLM-visible? | Editable by |
|---|---|---|---|
| **config** (technical) | `~/.moumantai/apps/<id>/config.json` + `.env` (Zod-validated; `secretField()` brand routes secrets to `.env`) | **No** | CLI wizard at install / `app configure`; file-edit fallback |
| **context** (LLM-visible preferences) | `~/.moumantai/apps/<id>/context.json` (Zod-validated) | **Yes** — populated into `AppContext.context` every turn | CLI wizard + LLM via synthesized `update_context` tool |
| **data** | `~/.moumantai/apps/<id>/db.sqlite` (Drizzle: `cache_*` upstream-mirrored + plain user-owned tables) | Indirect via faces | Tools, refresh tasks |

Platform-level **profile** tier (cross-app: locale, timezone, accessibility) is not implemented in the initial release.

## SDK additions for viewer apps

| Import | What |
|---|---|
| `defineRefreshTask({ id, every, mountedOnly?, warmup?, run })` | App-level cron-like task. `run` returns `{ nextRun }` for adaptive cadence. `mountedOnly: true` (default) gates ticks on at least one client mounted in this app's scope. `warmup: true` (default for `mountedOnly`) runs once at app boot regardless of mount. |
| `defineFace({ refresh: { every, warmup?, run } })` | Face-bound refresh, parameterized by face params, lifecycle-bound to mounts. **One worker per distinct (faceId, params)** even across multiple devices (deduped). |
| `secretField()` | Zod brand routing fields to `.env` (vs `config.json`). Hidden from LLM by construction. |
| `ctx.http.fetch(url, opts?)` | 10s timeout, 3× retry+backoff, per-host circuit breaker (5 5xx → 1m), per-app token-bucket budget. |
| `ctx.cacheAsset(url): Promise<string>` | Content-addressable per-app store. Returns `/apps/<id>/assets/<sha256-prefix>.<ext>`. |
| `ctx.staleness(taskId): { fetchedAt, isFailing, lastError, refresh }` | Per-task staleness for composing UI freshness affordances. |
| `ctx.config / ctx.context / ctx.setContext` | Typed app config/context per app. |

## CLI

| Command | What |
|---|---|
| `task server:cli -- app cache-clear <id> [--yes]` | Wipe an app's asset cache. Next refresh repopulates. |

## What we considered and rejected

- **Per-client cadence cap** (delta throttling per device) — causes drift between a user's own devices for marginal battery savings the OS already provides.
- **Reactive face dependency tracking** — too much infra for v1 scale; coarse re-resolve via existing `refreshAllFaces(appId)` is sub-millisecond.
- **Per-table staleness API** — ambiguous failure attribution when multiple tasks write the same table; per-task is the unambiguous primitive.
- **Webhook ingress** (`defineWebhookHandler`) — deferred until we add a webhook-driven app.
- **Single config schema with `.preference()` marker** — conflates storage routing and LLM exposure; the tier model is honest about the distinction.
- **Soft budget cap (warn-only)** — vestigial within weeks; ESPN bans us silently. Hard cap with visible failure beats theater.
