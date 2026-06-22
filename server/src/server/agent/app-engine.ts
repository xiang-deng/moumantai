/**
 * App Engine
 *
 * Registers, boots, and manages app instances.
 *
 * Boot model:
 *   - `register()` records an AppDefinition (DORMANT). No SQLite work yet.
 *   - `use(appId)` or `boot(appId)` transitions to ACTIVE:
 *       1. Open file-backed SQLite at `<home>/apps/<appId>/db.sqlite`
 *       2. Run migrations (idempotent after first boot)
 *       3. Build tool + face registries
 *       4. Record `lastUsedAt` for LRU + idle eviction
 *   - An idle sweeper (opt-in via `startSweeper()`) evicts apps that have
 *     been untouched for `idleTimeoutMs` and have no pending turns. `home`
 *     (or anything in `eagerBootList`) is never idle-evicted.
 *   - Booting past `maxActiveApps` evicts the LRU candidate first, waiting
 *     up to 500ms for its queue to drain before proceeding.
 *
 * Test convenience: zero-args constructor creates an isolated temp home +
 * no-op queue/store.
 */

import type { AppDefinition, ToolDefinition, HttpClient } from './types.js'
import type { AppManifest } from '../framework/app-types.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { TurnQueue } from './turn-queue.js'
import type { ConversationStore } from '../conversations/store.js'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toToolSchema } from './types.js'
import { FaceRegistry } from './face-loader.js'
import { appPaths } from '../workspace/home.js'
import { bootApp } from './boot-app.js'

// ---------------------------------------------------------------------------
// Booted App
// ---------------------------------------------------------------------------

export interface BootedApp {
  manifest: AppManifest
  schema?: Record<string, unknown>
  db: BetterSQLite3Database
  toolRegistry: Map<string, ToolDefinition>
  faceRegistry: FaceRegistry
  skill?: string
  /** Absolute path to the app directory on disk. Set post-boot by main.ts. */
  appDir?: string
  /** 'active' while handle is open; briefly 'evicting' during teardown. */
  state: 'active' | 'evicting'
  /** Millis-since-epoch. Bumped by `use(appId)` on every hot-path access. */
  lastUsedAt: number
  /**
   * LLM-visible app preferences. Loaded from `<home>/apps/<appId>/context.json`
   * against `appDef.context` (Zod schema) at boot time. Threaded into every
   * face resolve via `FaceResolveDeps.context` and into every tool execute via
   * `ToolContext.context`. Empty `{}` when no schema is declared on the app.
   */
  context: Record<string, unknown>
  /**
   * Technical setup config. Loaded from `<home>/apps/<appId>/config.json`
   * + `<home>/apps/<appId>/.env` against `appDef.config` (Zod schema) at boot
   * time. Threaded into every tool execute via `ToolContext.config`. NOT
   * exposed to the LLM. Empty `{}` when no schema is declared on the app.
   */
  config: Record<string, unknown>
  /**
   * Per-app HTTP client. Populated by the host (main.ts setAfterBootHook)
   * when the app declares an `upstream` config or any tool / refresh task
   * that calls `ctx.http.fetch`. Optional — apps that don't touch the network
   * leave it undefined and the `ToolContext.http` field stays unset.
   */
  httpClient?: HttpClient
  /**
   * Per-app asset cache function. Same wiring rules as `httpClient`:
   * built by the host once per booted app, GC'd on evict.
   */
  assetCache?: (url: string) => Promise<string>
}

/** Derive wire-safe tool schemas from the registry. Single source of truth. */
export function getToolSchemas(app: BootedApp) {
  return [...app.toolRegistry.values()].map(toToolSchema)
}

// ---------------------------------------------------------------------------
// Dependencies & knobs
// ---------------------------------------------------------------------------

export interface AppEngineDeps {
  /** Absolute path to Moumantai home; `<home>/apps/<appId>/db.sqlite` is per-app. */
  home?: string
  /** Used by the idle sweep to check for active conversations per app. */
  store?: ConversationStore
  /** Used by the idle sweep + LRU cap to gate on in-flight turns. */
  turnQueue?: TurnQueue
  /** Default 15 min; env `MOUMANTAI_APP_IDLE_MS` overrides. */
  idleTimeoutMs?: number
  /** Default 20; env `MOUMANTAI_MAX_ACTIVE_APPS` overrides. */
  maxActiveApps?: number
  /** Default 60s (not env-exposed per plan). */
  sweepIntervalMs?: number
  /** Default `['home']` — never idle-evicted, never LRU-evicted. */
  eagerBootList?: string[]
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_ACTIVE_APPS = 20
const DEFAULT_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_EAGER_BOOT_LIST: readonly string[] = ['home']
const CAP_EVICT_DRAIN_MS = 500

function readIdleTimeoutEnv(): number | undefined {
  const raw = process.env.MOUMANTAI_APP_IDLE_MS
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function readMaxActiveAppsEnv(): number | undefined {
  const raw = process.env.MOUMANTAI_MAX_ACTIVE_APPS
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// ---------------------------------------------------------------------------
// App Engine
// ---------------------------------------------------------------------------

export class AppEngine {
  private definitions = new Map<string, AppDefinition>()
  private apps = new Map<string, BootedApp>()

  private readonly home: string
  private readonly store?: ConversationStore
  private readonly turnQueue?: TurnQueue
  private readonly idleTimeoutMs: number
  private readonly maxActiveApps: number
  private readonly sweepIntervalMs: number
  private readonly eagerBootList: Set<string>

  private sweeper: ReturnType<typeof setInterval> | null = null

  /**
   * Fires after every successful boot, after the BootedApp enters `this.apps`
   * but before `boot()` resolves. Used to attach `appDir` and run
   * supplemental-tool / synth-face-tool wiring for lazy-booted apps.
   */
  private afterBootHook: ((appId: string) => Promise<void> | void) | null = null

  /**
   * Fires before each eviction (idle, cap, unregister, swapApp, shutdown),
   * after `state = 'evicting'` but before the DB handle closes. Used to
   * release resources keyed on the BootedApp instance. Errors are caught
   * and logged so a misbehaving hook can't leave an app stuck in 'evicting'.
   */
  private beforeEvictHook: ((appId: string) => Promise<void> | void) | null = null

  constructor(deps: AppEngineDeps = {}) {
    // home: deps.home → per-instance tempdir (test convenience: `new AppEngine()`).
    this.home = deps.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-engine-'))
    this.store = deps.store
    this.turnQueue = deps.turnQueue

    this.idleTimeoutMs = deps.idleTimeoutMs ?? readIdleTimeoutEnv() ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxActiveApps = deps.maxActiveApps ?? readMaxActiveAppsEnv() ?? DEFAULT_MAX_ACTIVE_APPS
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.eagerBootList = new Set(deps.eagerBootList ?? DEFAULT_EAGER_BOOT_LIST)
  }

  /** Register an app definition. Does not boot it yet. */
  register(appDef: AppDefinition): void {
    this.definitions.set(appDef.manifest.id, appDef)
  }

  /** Install the post-boot hook. Exactly one at a time. */
  setAfterBootHook(cb: ((appId: string) => Promise<void> | void) | null): void {
    this.afterBootHook = cb
  }

  /** Install the pre-evict hook. Exactly one at a time. */
  setBeforeEvictHook(cb: ((appId: string) => Promise<void> | void) | null): void {
    this.beforeEvictHook = cb
  }

  /** Register multiple app definitions at once. */
  registerAll(defs: AppDefinition[]): void {
    for (const def of defs) {
      this.register(def)
    }
  }

  /** Boot a single app (database → migrations → tools → faces). */
  async boot(appId: string): Promise<void> {
    const appDef = this.definitions.get(appId)
    if (!appDef) {
      throw new Error(`AppEngine: no definition registered for "${appId}"`)
    }

    // Already active? Just bump lastUsedAt and return.
    const existing = this.apps.get(appId)
    if (existing && existing.state === 'active') {
      existing.lastUsedAt = Date.now()
      return
    }

    // LRU cap-breach eviction: bounded 500ms drain, then proceed.
    if (this.apps.size >= this.maxActiveApps) {
      await this.evictLruCandidate()
    }

    const startedAt = Date.now()

    // Pure boot mechanics are in `bootApp` (shared with DraftRegistry).
    // Lifecycle policy (apps map, afterBootHook, LRU/idle bookkeeping) stays here.
    const dbPath = appPaths(this.home, appId).dbFile
    this.apps.set(appId, bootApp({ appDef, dbPath, home: this.home, appId }))

    console.log(
      JSON.stringify({
        event: 'app_boot',
        appId,
        latencyMs: Date.now() - startedAt,
      }),
    )

    if (this.afterBootHook) {
      try {
        await this.afterBootHook(appId)
      } catch (err) {
        // Log and continue — DB/registry state is valid; the hook owns remediation.
        console.error(
          `[app-engine] afterBootHook for "${appId}" failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  /** Boot all registered apps. Per-app failures are isolated and logged. */
  async bootAll(): Promise<{ booted: string[]; failed: Array<{ id: string; error: Error }> }> {
    const booted: string[] = []
    const failed: Array<{ id: string; error: Error }> = []

    for (const appId of this.definitions.keys()) {
      try {
        await this.boot(appId)
        booted.push(appId)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        console.error(`[app-engine] Failed to boot "${appId}":`, error.message)
        this.definitions.delete(appId)
        failed.push({ id: appId, error })
      }
    }

    return { booted, failed }
  }

  /**
   * Hot-path accessor. Boots the app if DORMANT (migrations are idempotent so
   * repeat boots are fast), or bumps `lastUsedAt` and returns the active app.
   * All hot-path callers should use this to keep LRU tracking accurate.
   */
  async use(appId: string): Promise<BootedApp> {
    const existing = this.apps.get(appId)
    if (existing && existing.state === 'active') {
      existing.lastUsedAt = Date.now()
      return existing
    }
    await this.boot(appId)
    const app = this.apps.get(appId)
    if (!app) throw new Error(`AppEngine: boot("${appId}") did not produce a BootedApp`)
    return app
  }

  // -------------------------------------------------------------------------
  // Hot-reload & dynamic mutation
  // -------------------------------------------------------------------------

  /** Unregister an app. Closes the DB handle if the app is currently active. */
  unregister(appId: string): boolean {
    const hadDef = this.definitions.delete(appId)
    const app = this.apps.get(appId)
    if (app) {
      app.state = 'evicting'
      void this.runBeforeEvictHook(appId)
      this.closeAppDbSafely(app)
      this.apps.delete(appId)
    }
    return hadDef || app !== undefined
  }

  /** Atomic register + reboot. Primary entry point for hot-reload. */
  async swapApp(appDef: AppDefinition): Promise<void> {
    const appId = appDef.manifest.id

    // Close before re-opening to avoid two drizzle instances on the same file.
    const existing = this.apps.get(appId)
    if (existing) {
      existing.state = 'evicting'
      await this.runBeforeEvictHook(appId)
      this.closeAppDbSafely(existing)
      this.apps.delete(appId)
    }

    this.register(appDef)
    await this.boot(appId)
  }

  /** Add a tool to a booted app at runtime. */
  addTool(appId: string, tool: ToolDefinition): void {
    const app = this.apps.get(appId)
    if (!app) throw new Error(`AppEngine: "${appId}" is not booted`)
    app.toolRegistry.set(tool.name, tool)
  }

  /** Remove a tool from a booted app at runtime. */
  removeTool(appId: string, toolName: string): boolean {
    const app = this.apps.get(appId)
    if (!app) return false
    return app.toolRegistry.delete(toolName)
  }

  /**
   * Return a booted app by id, or `undefined` if not active. Does NOT
   * auto-boot — use `use(appId)` for lazy-boot semantics.
   */
  getApp(appId: string): BootedApp | undefined {
    const app = this.apps.get(appId)
    if (!app) return undefined
    return app.state === 'active' ? app : undefined
  }

  /** List all registered app manifests. */
  listApps(): AppManifest[] {
    return [...this.definitions.values()].map((d) => d.manifest)
  }

  /**
   * Look up the original AppDefinition — provides fields the BootedApp doesn't
   * carry (e.g. `upstream`, `refreshTasks`, config schema). Returns undefined
   * if the app was never registered.
   */
  getDefinition(appId: string): AppDefinition | undefined {
    return this.definitions.get(appId)
  }

  // -------------------------------------------------------------------------
  // Lifecycle: sweeper + eviction
  // -------------------------------------------------------------------------

  /** Start the idle eviction sweep. Idempotent. Caller controls timing. */
  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      void this.sweepIdle().catch((err) => {
        console.error('[app-engine] sweep error:', err)
      })
    }, this.sweepIntervalMs)
    // Don't block process exit on the sweep timer.
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  /** Stop the idle eviction sweep. Safe to call multiple times. */
  stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = null
  }

  /**
   * One pass of the idle sweep. Exposed for tests / graceful shutdown so the
   * sweep can be driven deterministically without waiting for `setInterval`.
   */
  async sweepIdle(now: number = Date.now()): Promise<void> {
    const victims: string[] = []

    for (const [appId, app] of this.apps) {
      if (app.state !== 'active') continue
      if (this.eagerBootList.has(appId)) continue
      if (now - app.lastUsedAt < this.idleTimeoutMs) continue
      if (this.appHasPendingTurns(appId)) continue
      victims.push(appId)
    }

    for (const appId of victims) {
      await this.evict(appId, 'idle')
    }
  }

  /**
   * Evict all active apps and stop the sweeper. Synchronous by design —
   * SIGTERM aborts in-flight work separately; holding up exit on a stuck
   * tool would be worse than closing the handle. Safe to call multiple times.
   */
  shutdown(): void {
    this.stopSweeper()

    const ids = [...this.apps.keys()]
    for (const id of ids) {
      const app = this.apps.get(id)
      if (!app) continue
      app.state = 'evicting'
      // Fire-and-forget: shutdown is sync; hooks should tolerate the process
      // exiting before they complete.
      void this.runBeforeEvictHook(id)
      this.closeAppDbSafely(app)
      this.apps.delete(id)
      console.log(JSON.stringify({ event: 'app_evict', appId: id, reason: 'shutdown' }))
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private appHasPendingTurns(appId: string): boolean {
    if (!this.store || !this.turnQueue) return false
    const convIds = this.store.activeConversationIdsForApp(appId)
    return convIds.some((c) => this.turnQueue!.hasPending(c))
  }

  /**
   * Evict the LRU eligible app (not in eagerBootList, no pending turns).
   * Waits up to `CAP_EVICT_DRAIN_MS` for conversations to drain. Falls back
   * to the oldest non-eager app if no clean candidate exists, allowing a
   * brief over-cap rather than blocking user input.
   */
  private async evictLruCandidate(): Promise<void> {
    const candidates = [...this.apps.values()].filter((a) => {
      if (a.state !== 'active') return false
      if (this.eagerBootList.has(a.manifest.id)) return false
      return true
    })
    if (candidates.length === 0) return

    // Prefer clean candidates (no pending turns) by oldest lastUsedAt.
    const clean = candidates.filter((a) => !this.appHasPendingTurns(a.manifest.id))
    const pool = clean.length > 0 ? clean : candidates
    pool.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const victim = pool[0]!

    // Bounded drain: wait up to CAP_EVICT_DRAIN_MS for pending turns to finish.
    if (this.store && this.turnQueue) {
      const convIds = this.store.activeConversationIdsForApp(victim.manifest.id)
      if (convIds.length > 0) {
        await Promise.race([
          Promise.all(convIds.map((c) => this.turnQueue!.drain(c))),
          new Promise<void>((resolve) => setTimeout(resolve, CAP_EVICT_DRAIN_MS)),
        ])
      }
    }

    await this.evict(victim.manifest.id, 'cap')
  }

  private async evict(appId: string, reason: 'idle' | 'cap'): Promise<void> {
    const app = this.apps.get(appId)
    if (!app) return

    app.state = 'evicting'

    // Best-effort drain for idle; cap-breach already drained with a bounded wait.
    if (reason === 'idle' && this.store && this.turnQueue) {
      const convIds = this.store.activeConversationIdsForApp(appId)
      if (convIds.length > 0) {
        await Promise.all(convIds.map((c) => this.turnQueue!.drain(c)))
      }
    }

    await this.runBeforeEvictHook(appId)
    this.closeAppDbSafely(app)
    this.apps.delete(appId)

    console.log(JSON.stringify({ event: 'app_evict', appId, reason }))
  }

  private async runBeforeEvictHook(appId: string): Promise<void> {
    if (!this.beforeEvictHook) return
    try {
      await this.beforeEvictHook(appId)
    } catch (err) {
      console.error(
        `[app-engine] beforeEvictHook for "${appId}" failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  private closeAppDbSafely(app: BootedApp): void {
    try {
      const client = (app.db as unknown as { $client?: { close?: () => void } }).$client
      client?.close?.()
    } catch (err) {
      console.error('[app-engine] error closing DB handle:', err)
    }
  }
}
