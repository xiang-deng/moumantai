/**
 * DraftStore — public surface for the draft-editing pipeline.
 *
 * Owns draft materialization, `.meta.json` lifecycle, and promote/discard
 * orchestration. FS/DB mechanics live in draft-fs / draft-db; boot state in
 * DraftRegistry; rollback-safe promote in draft-promote. The WS layer drives
 * transport broadcasts and the edit-agent turn on top of this.
 *
 * A per-draft promote lock (`promoteInFlight`) blocks discard while a promote
 * is running.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { appIdToScope } from '@moumantai/protocol'
import type { ConversationStore } from '../conversations/store.js'
import type { AppEngine } from '../agent/app-engine.js'
import { DraftRegistry } from './draft-registry.js'
import { appPaths, draftPaths, homeLayout } from '../workspace/home.js'
import {
  reloadSingleApp,
  reloadDraftDef,
  reloadAppBundled,
  findEntryFile,
} from '../agent/app-loader.js'
import { materializeDraftWorktree, materializeSkill, removeDraftWorktree } from './draft-fs.js'
import { scaffoldNewAppDraft } from './draft-scaffold.js'
import { cloneLiveDbToShadow, createEmptyShadow } from './draft-db.js'
import { promoteDraft as runPromote } from './draft-promote.js'
import type { DraftMeta, DraftActionOutcome, DraftKindStr } from './types.js'

export interface DraftStoreDeps {
  home: string
  draftRegistry: DraftRegistry
  conversationStore: ConversationStore
  appEngine: AppEngine
  /** `<repo>/.claude/skills` — source for per-draft skill materialization. */
  skillsRepoDir: string
  /** Persist a promotions audit row (platform.db). */
  recordPromotion: (p: {
    draftId: string
    appId: string
    promotedAt: string
    summary?: string
    msgCount: number
  }) => void
  /** Injected clock (testability). Defaults to `() => new Date()`. */
  now?: () => Date
}

export type CreateDraftOpts = { kind: 'edit'; appId: string } | { kind: 'new-app' }

export interface CreateDraftResult {
  draftId: string
  conversationId: string
  meta: DraftMeta
}

const SKILL_FOR_KIND: Record<DraftKindStr, string> = {
  edit: 'edit-moumantai-app',
  'new-app': 'build-moumantai-app',
}

export class DraftStore {
  private promoteInFlight = new Set<string>()
  private now: () => Date

  constructor(private deps: DraftStoreDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Materialize a new draft. EDIT: copies live source + clones live DB, boots
   * the draft. NEW-APP: lays down skill + metadata only; boots on first reload.
   * Always creates the linked `kind='dev'` conversation. Throws on failure
   * after best-effort cleanup.
   */
  async createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult> {
    const draftId = crypto.randomUUID()
    const { home } = this.deps
    const dp = draftPaths(home, draftId)
    const kind: DraftKindStr = opts.kind
    // edit: appId is the live id; new-app: appId starts as the draftId placeholder.
    const appId = opts.kind === 'edit' ? opts.appId : draftId
    const scope = opts.kind === 'edit' ? appIdToScope(appId) : 'home'

    try {
      if (opts.kind === 'edit') {
        const live = this.deps.appEngine.getApp(opts.appId)
        const liveSrcDir = live?.appDir ?? path.join(homeLayout(home).appsSrcDir, opts.appId)
        if (!fs.existsSync(liveSrcDir)) {
          throw new Error(`live app source not found for "${opts.appId}" (${liveSrcDir})`)
        }
        materializeDraftWorktree({ liveSrcDir, draftDir: dp.dir })
        cloneLiveDbToShadow(appPaths(home, opts.appId).dbFile, dp.shadowDbFile)
      } else {
        // New-app: empty worktree + shadow dir, then stamp a generic skeleton
        // (symmetric with edit drafts). Fail-soft if templates are absent.
        materializeDraftWorktree({ liveSrcDir: null, draftDir: dp.dir })
        createEmptyShadow(dp.shadowDir)
        scaffoldNewAppDraft(this.deps.skillsRepoDir, dp.dir)
      }

      // Materialize only the relevant skill into the worktree.
      const skillName = SKILL_FOR_KIND[kind]
      materializeSkill(
        path.join(this.deps.skillsRepoDir, skillName),
        path.join(dp.skillDir, skillName),
      )

      // Write metadata last so a partial materialization is an obvious orphan.
      const meta: DraftMeta = {
        draftId,
        appId,
        kind,
        createdAt: this.now().getTime(),
        msgCount: 0,
        readyForReview: false,
      }
      this.writeMeta(draftId, meta)

      // Linked dev conversation.
      const conv = this.deps.conversationStore.getActive(scope, 'dev', draftId)

      // EDIT drafts boot immediately. NEW-APP drafts boot on first post-scaffold reload.
      if (opts.kind === 'edit') {
        const appDef = await reloadSingleApp(dp.dir)
        this.deps.draftRegistry.register(draftId, appDef, { appId, kind, draftDir: dp.dir })
        await this.deps.draftRegistry.boot(draftId)
      }

      return { draftId, conversationId: conv.id, meta }
    } catch (err) {
      // Rollback: remove the partial worktree and archive the dev conversation
      // if created — otherwise the (scope, kind='dev') unique-active index
      // would block a retry with the orphaned active row.
      removeDraftWorktree(dp.dir)
      const orphan = this.deps.conversationStore.findDevConversationByDraft(draftId)
      if (orphan) this.deps.conversationStore.archive(orphan.id)
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Metadata + lookup
  // -------------------------------------------------------------------------

  getDraft(draftId: string): DraftMeta | undefined {
    return this.readMeta(draftId)
  }

  /** Find an active EDIT draft for a live app id (at most one per app). */
  getDraftByApp(appId: string): DraftMeta | undefined {
    return this.listActiveDrafts().find((m) => m.kind === 'edit' && m.appId === appId)
  }

  /** All drafts currently materialized on disk (reads each `.meta.json`). */
  listActiveDrafts(): DraftMeta[] {
    const dir = homeLayout(this.deps.home).appsDraftsDir
    if (!fs.existsSync(dir)) return []
    const out: DraftMeta[] = []
    for (const draftId of fs.readdirSync(dir)) {
      const meta = this.readMeta(draftId)
      if (meta) out.push(meta)
    }
    return out
  }

  /** Clear ready-for-review (called on every new dev-chat message). */
  markDirty(draftId: string): void {
    this.updateMeta(draftId, (m) => ({ ...m, readyForReview: false }))
  }

  /** Set ready-for-review + summary (request_promote_review, all validators passed). */
  markReadyForReview(draftId: string, summary: string): void {
    this.updateMeta(draftId, (m) => ({ ...m, readyForReview: true, summary }))
  }

  /** Bump message count + last-message time (per dev-chat message). */
  incrementMsgCount(draftId: string): void {
    this.updateMeta(draftId, (m) => ({
      ...m,
      msgCount: m.msgCount + 1,
      lastMsgAt: this.now().getTime(),
    }))
  }

  /** Zero the message count (dev-conversation reset — the thread is now empty). */
  resetMsgCount(draftId: string): void {
    this.updateMeta(draftId, (m) => ({ ...m, msgCount: 0 }))
  }

  /** Record the agent-chosen manifest.id for new-app drafts after first scaffold reload. */
  updateAppId(draftId: string, appId: string): void {
    this.updateMeta(draftId, (m) => ({ ...m, appId }))
  }

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  /**
   * Reload a draft from disk (`[Reload preview]`). For a NEW-APP draft, this
   * is also the first boot — registers then boots before swapping. Detects the
   * agent-chosen manifest.id and updates metadata when it has changed.
   */
  async reloadDraft(draftId: string): Promise<DraftActionOutcome & { appId?: string }> {
    const meta = this.readMeta(draftId)
    if (!meta) return { ok: false, error: `draft "${draftId}" not found` }
    const dp = draftPaths(this.deps.home, draftId)
    try {
      if (!this.deps.draftRegistry.get(draftId)) {
        // First reload of a (new-app) draft: register from disk, then boot.
        const appDef = await reloadDraftDef(dp.dir)
        this.deps.draftRegistry.register(draftId, appDef, {
          appId: appDef.manifest.id,
          kind: meta.kind,
          draftDir: dp.dir,
        })
        await this.deps.draftRegistry.boot(draftId)
        if (appDef.manifest.id !== meta.appId) this.updateAppId(draftId, appDef.manifest.id)
        return { ok: true, appId: appDef.manifest.id }
      }
      const { appId } = await this.deps.draftRegistry.reload(draftId)
      if (appId !== meta.appId) this.updateAppId(draftId, appId)
      return { ok: true, appId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // -------------------------------------------------------------------------
  // Promote / Discard
  // -------------------------------------------------------------------------

  /** Promote a draft. Holds the per-draft lock for the duration. */
  async promoteDraft(draftId: string): Promise<DraftActionOutcome> {
    const meta = this.readMeta(draftId)
    if (!meta) return { ok: false, error: `draft "${draftId}" not found` }
    if (this.promoteInFlight.has(draftId)) {
      return { ok: false, error: 'Promote already in progress for this draft' }
    }
    this.promoteInFlight.add(draftId)
    try {
      const outcome = await runPromote(
        {
          home: this.deps.home,
          draftRegistry: this.deps.draftRegistry,
          liveSrcDir: (appId) =>
            this.deps.appEngine.getApp(appId)?.appDir ??
            path.join(homeLayout(this.deps.home).appsSrcDir, appId),
          liveDbPath: (appId) => appPaths(this.deps.home, appId).dbFile,
          existingAppIds: (excludeDraftId) => {
            const ids = new Set(this.deps.appEngine.listApps().map((m) => m.id))
            for (const d of this.deps.draftRegistry.listActiveDrafts()) {
              if (d.draftId !== excludeDraftId) ids.add(d.appId)
            }
            return ids
          },
          activateLive: async (appId, kind) => {
            const srcDir =
              this.deps.appEngine.getApp(appId)?.appDir ??
              path.join(homeLayout(this.deps.home).appsSrcDir, appId)
            // Bundle-load so a promote of edits to PRE-EXISTING files (resolve.ts,
            // schema.ts, …) activates the new code — `reloadSingleApp` would
            // stale-load those children from the live app's boot-time cache.
            // Scratch goes in <home>/tmp (not a watched appDir).
            const entry = findEntryFile(srcDir)
            if (!entry) throw new Error(`No index.ts/js in ${srcDir} after promote copy`)
            const def = await reloadAppBundled(entry, path.join(this.deps.home, 'tmp'))
            if (kind === 'edit') {
              await this.deps.appEngine.swapApp(def)
            } else {
              this.deps.appEngine.register(def)
              await this.deps.appEngine.boot(appId)
            }
          },
          recordPromotion: this.deps.recordPromotion,
          now: this.now,
        },
        draftId,
        meta,
      )
      if (outcome.ok) this.archiveDevConversation(draftId)
      return outcome
    } finally {
      this.promoteInFlight.delete(draftId)
    }
  }

  /**
   * Discard a draft: archive its dev conversation, unregister (closes shadow
   * DB), remove the worktree. Rejected while a promote holds the lock.
   * Caller must abort any in-flight agent turn first.
   */
  discardDraft(draftId: string): DraftActionOutcome {
    if (this.promoteInFlight.has(draftId)) {
      return { ok: false, error: 'Promote in progress — try again in a moment' }
    }
    this.archiveDevConversation(draftId)
    this.deps.draftRegistry.unregister(draftId)
    removeDraftWorktree(draftPaths(this.deps.home, draftId).dir)
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private archiveDevConversation(draftId: string): void {
    const conv = this.deps.conversationStore.findDevConversationByDraft(draftId)
    if (conv) this.deps.conversationStore.archive(conv.id)
  }

  private readMeta(draftId: string): DraftMeta | undefined {
    const file = draftPaths(this.deps.home, draftId).metaFile
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as DraftMeta
    } catch {
      return undefined
    }
  }

  private writeMeta(draftId: string, meta: DraftMeta): void {
    const file = draftPaths(this.deps.home, draftId).metaFile
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n')
    fs.renameSync(tmp, file)
  }

  private updateMeta(draftId: string, fn: (m: DraftMeta) => DraftMeta): void {
    const meta = this.readMeta(draftId)
    if (!meta) return
    this.writeMeta(draftId, fn(meta))
  }
}
