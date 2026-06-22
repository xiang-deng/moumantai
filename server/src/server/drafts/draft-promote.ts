/**
 * Orchestrated, rollback-safe Promote.
 *
 * EDIT draft:
 *   1. PRE-FLIGHT — run migrations against a throwaway live clone; abort if
 *      migrate() throws (e.g. NOT NULL add against grown live data).
 *   2. SNAPSHOT  — copy live source to `<home>/tmp/promote-rollback-…`.
 *   3. MIGRATE   — apply migrations to the real live DB.
 *   4. COPY      — mirror worktree → live apps-src (ephemerals excluded).
 *      Draft data is discarded; live data is preserved + migrated.
 *   5. ACTIVATE  — hot-swap the live app from the updated source.
 *   6. RECORD    — append a promotions audit row.
 *   7. CLEANUP   — remove worktree + tmp snapshot + tmp migration-check clone.
 *   On failure after COPY starts, restore the source from the snapshot.
 *
 * NEW-APP draft: steps 1–3 are skipped. Runs a manifest.id collision check,
 * then copy → activate → record.
 */

import path from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type Database from 'better-sqlite3'
import type { DraftRegistry } from './draft-registry.js'
import type { DraftMeta, DraftActionOutcome } from './types.js'
import { cloneLiveDbToShadow } from './draft-db.js'
import { mirrorInto, snapshotDir, removeDraftWorktree, removeTmpPath } from './draft-fs.js'

export interface PromoteDeps {
  home: string
  draftRegistry: DraftRegistry
  /** Live app's on-disk source dir (promote destination). */
  liveSrcDir: (appId: string) => string
  /** Live app's DB file path (edit drafts only). */
  liveDbPath: (appId: string) => string
  /** Live + other-draft app ids, excluding the given draft — new-app collision. */
  existingAppIds: (excludeDraftId: string) => Set<string>
  /** Re-activate the promoted app as live (edit: swap; new-app: register+boot). */
  activateLive: (appId: string, kind: 'edit' | 'new-app') => Promise<void>
  /** Persist a promotions audit row. */
  recordPromotion: (p: {
    draftId: string
    appId: string
    promotedAt: string
    summary?: string
    msgCount: number
  }) => void
  /** Injected clock — avoids Date in hot paths and keeps promote testable. */
  now: () => Date
}

function migrateInPlace(dbPath: string, migrationsFolder: string): void {
  const db = drizzle({ connection: dbPath, casing: 'snake_case' })
  try {
    migrate(db, { migrationsFolder })
  } finally {
    ;(db as unknown as { $client: Database.Database }).$client.close()
  }
}

/**
 * Promote `draftId`. Returns a structured outcome (never throws for expected
 * failure modes — pre-flight failure, collision, rollback). The caller holds
 * the per-draft promote lock and maps the outcome to the wire ACK.
 */
export async function promoteDraft(
  deps: PromoteDeps,
  draftId: string,
  meta: DraftMeta,
): Promise<DraftActionOutcome> {
  const entry = deps.draftRegistry.get(draftId)
  if (!entry) return { ok: false, error: `draft "${draftId}" not found` }

  const finalAppId = entry.appDef.manifest.id
  const migrationsFolder = entry.appDef.migrationsFolder
  const tmpDir = path.join(deps.home, 'tmp')

  // ---- NEW-APP path: no live db/source; collision-check then copy + activate.
  if (entry.kind === 'new-app') {
    if (deps.existingAppIds(draftId).has(finalAppId)) {
      return {
        ok: false,
        error: `App id "${finalAppId}" already exists. Ask the agent to rename it.`,
      }
    }
    const destSrc = deps.liveSrcDir(finalAppId)
    try {
      mirrorInto(entry.draftDir, destSrc)
      await deps.activateLive(finalAppId, 'new-app')
      deps.draftRegistry.unregister(draftId)
    } catch (err) {
      // The source dir was created fresh — remove the partial install on failure.
      // Draft stays registered so the user can fix + retry or Discard.
      removeTmpPath(destSrc)
      return { ok: false, error: `Promote failed while installing new app: ${errMsg(err)}` }
    }
    deps.recordPromotion({
      draftId,
      appId: finalAppId,
      promotedAt: deps.now().toISOString(),
      summary: meta.summary,
      msgCount: meta.msgCount,
    })
    removeDraftWorktree(entry.draftDir)
    return { ok: true }
  }

  // ---- EDIT path.
  const liveAppId = entry.appId
  const liveDb = deps.liveDbPath(liveAppId)
  const destSrc = deps.liveSrcDir(liveAppId)
  const migrationCheckDb = path.join(tmpDir, `promote-check-${draftId}.sqlite`)
  const rollbackSnapshot = path.join(tmpDir, `promote-rollback-${draftId}`)

  // 1. PRE-FLIGHT — migrate a throwaway clone of live; abort on throw.
  if (migrationsFolder) {
    try {
      cloneLiveDbToShadow(liveDb, migrationCheckDb)
      migrateInPlace(migrationCheckDb, migrationsFolder)
    } catch (err) {
      removeTmpPath(migrationCheckDb)
      return {
        ok: false,
        error: `Migration would fail on live data: ${errMsg(err)}. Live has changed since the draft was created — ask the agent to adjust.`,
      }
    }
    removeTmpPath(migrationCheckDb)
  }

  // 2. SNAPSHOT live source for rollback.
  try {
    snapshotDir(destSrc, rollbackSnapshot)
  } catch (err) {
    return { ok: false, error: `Promote aborted — could not snapshot live source: ${errMsg(err)}` }
  }

  // 3. MIGRATE live db (pre-flight passed; a race here leaves live unchanged
  //    because migrate is transactional per statement-group).
  try {
    if (migrationsFolder) migrateInPlace(liveDb, migrationsFolder)
  } catch (err) {
    removeTmpPath(rollbackSnapshot)
    return { ok: false, error: `Live migration failed: ${errMsg(err)}. Live source unchanged.` }
  }

  // 4. COPY worktree → live source (ephemerals excluded). 5. ACTIVATE.
  // Unregister ONLY after activation succeeds — if activateLive throws
  // (e.g. reloaded module fails validation), the draft must stay registered
  // so the user can fix + retry or Discard.
  try {
    mirrorInto(entry.draftDir, destSrc)
    await deps.activateLive(liveAppId, 'edit')
    deps.draftRegistry.unregister(draftId)
  } catch (err) {
    // Restore via mirror (not overlay) so files the failed promote partially wrote are pruned.
    try {
      mirrorInto(rollbackSnapshot, destSrc)
    } catch (restoreErr) {
      return {
        ok: false,
        error: `Promote failed (${errMsg(err)}) AND rollback failed (${errMsg(restoreErr)}). Manual recovery: restore ${destSrc} from ${rollbackSnapshot}.`,
      }
    }
    removeTmpPath(rollbackSnapshot)
    return { ok: false, error: `Promote failed and was rolled back: ${errMsg(err)}` }
  }

  // 6. RECORD + 7. CLEANUP.
  deps.recordPromotion({
    draftId,
    appId: liveAppId,
    promotedAt: deps.now().toISOString(),
    summary: meta.summary,
    msgCount: meta.msgCount,
  })
  removeDraftWorktree(entry.draftDir)
  removeTmpPath(rollbackSnapshot)
  return { ok: true }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
