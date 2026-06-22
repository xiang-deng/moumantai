/**
 * DraftRegistry — booted state for draft apps, separate from AppEngine.
 *
 * Keyed by `draftId` (not `manifest.id`) so drafts never pollute the live
 * app id-space and an EDIT draft can coexist with the live app it shadows.
 * Boots each draft against its shadow DB via the shared `bootApp` helper, then
 * (re)synthesizes `view_<faceId>` tools using a draft-scoped param-store key
 * (the draftId) so draft view-state never collides with the live app's.
 *
 * Drafts are never auto-evicted — lifecycle is user-driven (Promote/Discard).
 */

import type { AppDefinition } from '../agent/types.js'
import type { BootedApp } from '../agent/app-engine.js'
import type { FaceParamsStore } from '../agent/face-params-store.js'
import type { BroadcastTransport } from '../agent/broadcast.js'
import type Database from 'better-sqlite3'
import { bootApp } from '../agent/boot-app.js'
import { synthesizeFaceTool } from '../agent/synthesize-face-tool.js'
import {
  reloadDraftDef,
  findEntryFile,
  applySupplementalScan,
  draftBundleLoader,
} from '../agent/app-loader.js'
import { draftPaths } from '../workspace/home.js'
import type { DraftKindStr } from './types.js'

export interface DraftEntry {
  draftId: string
  /** Routing appId: live id for edit drafts; manifest.id for new-app (after scaffold). */
  appId: string
  kind: DraftKindStr
  /** Absolute path to the draft worktree. */
  draftDir: string
  /** Currently-loaded definition. */
  appDef: AppDefinition
  /** Booted state (DB handle + tool/face registries). */
  booted: BootedApp
}

export interface DraftRegistryDeps {
  /** Moumantai home — used to derive shadow-DB paths + load context/config. */
  home: string
  faceParamsStore: FaceParamsStore
  transport: BroadcastTransport
  /**
   * Count of sessions currently previewing a given draft. Injected by the host
   * (derived from ws-server live connections) so the refresh-task scheduler can
   * gate draft tasks on `> 0`. Defaults to 0 (no previewers) when not wired.
   */
  getOptedInSessionCount?: (draftId: string) => number
}

/** Close a BootedApp's underlying SQLite handle (drizzle exposes `$client`). */
function closeBootedDb(app: BootedApp): void {
  try {
    ;(app.db as unknown as { $client: Database.Database }).$client.close()
  } catch {
    /* best-effort — handle may already be closed */
  }
}

export class DraftRegistry {
  private drafts = new Map<string, DraftEntry>()

  constructor(private deps: DraftRegistryDeps) {}

  /** Record a draft definition. Does NOT boot it (call `boot`). */
  register(
    draftId: string,
    appDef: AppDefinition,
    opts: { appId: string; kind: DraftKindStr; draftDir: string },
  ): void {
    this.drafts.set(draftId, {
      draftId,
      appId: opts.appId,
      kind: opts.kind,
      draftDir: opts.draftDir,
      appDef,
      // Placeholder until boot(); kept non-null by booting immediately after
      // register in the normal flow.
      booted: undefined as unknown as BootedApp,
    })
  }

  /** Boot (or re-boot) a registered draft against its shadow DB. */
  async boot(draftId: string): Promise<void> {
    const entry = this.drafts.get(draftId)
    if (!entry) throw new Error(`DraftRegistry: no draft registered for "${draftId}"`)
    // Close any prior handle before re-opening (a direct re-boot, not via swap).
    if (entry.booted) closeBootedDb(entry.booted)
    const { shadowDbFile } = draftPaths(this.deps.home, draftId)
    entry.booted = bootApp({
      appDef: entry.appDef,
      dbPath: shadowDbFile,
      home: this.deps.home,
      appId: entry.appId,
    })
    // Supplemental scan mirrors the live boot (main.ts rewireApp) so preview
    // registers expanded/other size variants, not just the compact faces from
    // index.ts. Without this, phone preview falls back to compact.
    await applySupplementalScan({
      appDir: entry.draftDir,
      toolRegistry: entry.booted.toolRegistry,
      faceRegistry: entry.booted.faceRegistry,
      source: `draft:${draftId}`,
      // Bundle each scanned variant so edits to its children (parts/resolve)
      // are fresh — the expanded variant the phone shows comes from here.
      load: draftBundleLoader(entry.draftDir),
    })
    this.wireDraftSynthTools(entry)
  }

  /**
   * Replace the booted definition (after a `[Reload preview]` re-import). Closes
   * the old DB handle, boots the new def against the same shadow DB, and
   * re-wires synth tools.
   */
  async swap(draftId: string, newAppDef: AppDefinition): Promise<void> {
    const entry = this.drafts.get(draftId)
    if (!entry) throw new Error(`DraftRegistry: no draft registered for "${draftId}"`)
    if (entry.booted) closeBootedDb(entry.booted)
    entry.appDef = newAppDef
    // Track the agent-chosen id for new-app drafts so routing/AppList reflect it.
    entry.appId = newAppDef.manifest.id
    await this.boot(draftId)
  }

  /**
   * Re-import `<draft>/index.ts` (cache-busted) and swap. Returns the loaded
   * manifest.id so callers can detect a new-app draft's id change post-scaffold.
   * Throws a friendly error when the entry file doesn't exist yet (pre-scaffold).
   */
  async reload(draftId: string): Promise<{ appId: string }> {
    const entry = this.drafts.get(draftId)
    if (!entry) throw new Error(`DraftRegistry: no draft registered for "${draftId}"`)
    if (!findEntryFile(entry.draftDir)) {
      throw new Error(
        'No index.ts in draft worktree yet — wait for the agent to finish scaffolding',
      )
    }
    const appDef = await reloadDraftDef(entry.draftDir)
    await this.swap(draftId, appDef)
    return { appId: appDef.manifest.id }
  }

  /** Remove + tear down a draft (closes its DB handle). Idempotent. */
  unregister(draftId: string): void {
    const entry = this.drafts.get(draftId)
    if (!entry) return
    if (entry.booted) closeBootedDb(entry.booted)
    this.drafts.delete(draftId)
  }

  get(draftId: string): DraftEntry | undefined {
    return this.drafts.get(draftId)
  }

  /** Number of sessions currently previewing this draft (0 if not wired). */
  hasOptedInClients(draftId: string): number {
    return this.deps.getOptedInSessionCount?.(draftId) ?? 0
  }

  listActiveDrafts(): DraftEntry[] {
    return [...this.drafts.values()]
  }

  /** New-app drafts get an AppList entry; edit drafts reuse the live one. */
  listNewAppDrafts(): DraftEntry[] {
    return [...this.drafts.values()].filter((d) => d.kind === 'new-app')
  }

  /** Close every draft's DB handle (server shutdown). */
  shutdown(): void {
    for (const entry of this.drafts.values()) {
      if (entry.booted) closeBootedDb(entry.booted)
    }
    this.drafts.clear()
  }

  /**
   * (Re)synthesize `view_<faceId>` tools on the draft's booted app. Like the
   * live `wireSynthFaceTools` but uses a draft-scoped `paramsKey` (the draftId)
   * so view-state and stale-version sweeps never collide with the live app.
   */
  private wireDraftSynthTools(entry: DraftEntry): void {
    const { booted, appId, draftId } = entry
    const { faceParamsStore, transport } = this.deps
    for (const toolName of [...booted.toolRegistry.keys()]) {
      if (toolName.startsWith('view_')) booted.toolRegistry.delete(toolName)
    }
    for (const face of booted.faceRegistry.list()) {
      const tool = synthesizeFaceTool({
        appId,
        face,
        faceParamsStore,
        transport,
        paramsKey: draftId,
      })
      booted.toolRegistry.set(tool.name, tool)
    }
    faceParamsStore.sweepStaleVersions(draftId, booted.faceRegistry)
  }
}
