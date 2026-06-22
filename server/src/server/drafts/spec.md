# drafts/ — coding-agent draft editing

**Purpose:** Materialize, preview, and promote/discard shadow copies of apps so a coding agent can edit faces/tools (or scaffold a new app) at runtime without ever breaking the live version every other client sees.

## Public API

### `DraftStore` (`draft-store.ts`) — the surface the rest of the server uses
- `new DraftStore(deps)` — deps: `{ home, draftRegistry, conversationStore, appEngine, skillsRepoDir, recordPromotion, now? }`.
- `createDraft(opts: { kind: 'edit'; appId } | { kind: 'new-app' }): Promise<{ draftId, conversationId, meta }>` — materializes the worktree (edit: copy live source + clone live DB → shadow; new-app: empty), materializes the relevant skill, writes `.meta.json` last, creates the linked `kind='dev'` conversation, and (edit only) registers + boots the draft. New-app drafts boot on first reload.
- `getDraft(draftId): DraftMeta | undefined` / `getDraftByApp(appId)` / `listActiveDrafts(): DraftMeta[]`.
- `markDirty(draftId)` — clears `readyForReview` (every new dev-chat message).
- `markReadyForReview(draftId, summary)` — sets `readyForReview=true` + summary (request_promote_review, all validators passed).
- `incrementMsgCount(draftId)` / `updateAppId(draftId, appId)`.
- `reloadDraft(draftId): Promise<{ ok, error?, appId? }>` — `[Reload preview]`. Boots a new-app draft on first call; detects the agent-chosen `manifest.id` and updates metadata when it changes.
- `promoteDraft(draftId): Promise<{ ok, error? }>` — holds the per-draft promote lock; delegates to `draft-promote`.
- `discardDraft(draftId): { ok, error? }` — archives the dev conversation, unregisters (closes shadow DB), removes the worktree. Rejected while a promote is in flight. Caller aborts any in-flight agent turn first.

### `DraftRegistry` (`draft-registry.ts`) — booted state, separate from AppEngine
- `register(draftId, appDef, { appId, kind, draftDir })`, `boot(draftId)`, `swap(draftId, newAppDef)`, `reload(draftId): Promise<{ appId }>`, `unregister(draftId)`, `get(draftId)`, `hasOptedInClients(draftId)`, `listActiveDrafts()`, `listNewAppDrafts()`, `shutdown()`.
- Boots each draft against its shadow DB via the shared `bootApp` helper, then runs the **same `applySupplementalScan` the live boot runs** (so the draft registers `*.expanded.ts`/other size variants — without it preview only has the compact faces and renders "simplified" vs live; the scan uses a bundling loader so edited variant children are fresh), then (re)synthesizes `view_<faceId>` tools using a **draft-scoped param key (the draftId)** so view-state never collides with the live app it shadows.

### Helpers
- `draft-fs.ts`: `materializeDraftWorktree`, `materializeSkill`, `mirrorInto(srcDir, destDir)` (makes dest's promotable subset identical to src — copy + add + prune orphans; excludes ephemerals + `.git`; resolves a symlinked dev `apps-src/<id>` dest), `snapshotDir`, `removeDraftWorktree`, `removeTmpPath`, `isEphemeralDraftPath(rel)`.
- `draft-db.ts`: `cloneLiveDbToShadow` (consistent `VACUUM INTO` clone — handles the live WAL), `createEmptyShadow`, `applyMigrations`, `countDataRows` (excludes `cache_*` / `__drizzle_*` / `sqlite_*`).
- `draft-promote.ts`: `promoteDraft(deps, draftId, meta)` — pre-flight migration on a throwaway live clone → snapshot → migrate live → `mirrorInto` worktree (ephemerals excluded; prunes deleted/renamed files) → activate → record → cleanup, with a `mirrorInto` rollback from the snapshot on post-copy failure. Activation bundle-loads the live source so promoted edits to non-entry files take effect. New-app skips the DB steps and runs a manifest.id collision check. Known gap: the live DB migration is forward-only — a copy/activate failure after migration leaves the new schema with the old source (mitigated by the mirror restore; flagged, not auto-reverted).
- `promotions-schema.ts`: `promotions` table on platform.db (append-only audit log; one row per promote).

## Dependencies
`agent/boot-app` (shared boot), `agent/app-engine` (live activation + paths), `agent/synthesize-face-tool` (draft view-tools), `agent/app-loader` (`reloadDraftDef`/`reloadAppBundled` — full-graph bundle reload for preview/promote; `reloadSingleApp` for initial load), `conversations/store` (dev conversation), `workspace/home` (`draftPaths`/`appPaths`). Consumed by the WS layer (Phase 8) which adds transport broadcasts + the edit-agent turn.

## Constraints
- **A draft is one self-contained dir** `<home>/apps-drafts/<draftId>/`: app source + `.shadow/db.sqlite` + `.meta.json` + `.claude/skills/`. `rm -rf` it to discard.
- **Server-owned, agent-read-only, promote-excluded:** `.shadow/`, `.claude/`, `.meta.json`, `.progress.md`. `design.md` IS promoted.
- **Promote discards draft DATA; live data is preserved + migrated.** The shadow DB never carries rows into live.
- **One active draft per `(scope, kind)`** via the conversations partial unique index — one edit draft per app, one new-app draft globally (scope='home').
- **Drafts are never auto-evicted** — user owns the lifecycle (Promote/Discard). No idle sweep, no expiry.
- **Promote lock** blocks discard mid-promote; promote is bounded + atomic.
- Secrets never enter the worktree: an edit draft inherits the live app's `<home>/apps/<id>/.env` read-only via `bootApp`'s context/config load against the live appId.

## Example (happy path — edit a face)
```ts
const { draftId } = await draftStore.createDraft({ kind: 'edit', appId: 'today' })
// ... edit-agent edits files in the worktree, user taps [Reload preview] ...
await draftStore.reloadDraft(draftId)        // re-imports <draft>/index.ts, swaps the booted draft
// ... agent calls request_promote_review → markReadyForReview(draftId, summary) ...
const r = await draftStore.promoteDraft(draftId)  // pre-flight → migrate live → copy → activate → record
// r.ok === true; worktree gone; live 'today' hot-swapped everywhere; promotions row written.
```
