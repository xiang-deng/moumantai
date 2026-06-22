/**
 * Refresh-Task Scheduler (app-level)
 *
 * Manages per-app refresh tasks declared via `defineRefreshTask`. A task
 * is a server-driven cron-like callback that fetches upstream data and
 * writes the local DB without needing the LLM in the loop.
 *
 * Key behaviors (locked in design):
 *
 * - **Boot warmup.** Every task with `warmup: true` (default for
 *   `mountedOnly: true`) runs once at app boot regardless of mounted state.
 *   Solves the "fresh install search returns empty" bug.
 *
 * - **Mounted-set gating.** Tasks with `mountedOnly: true` (default) only
 *   tick when at least one client has the app's scope mounted
 *   (`activeScope = 'app:<appId>'`). Saves upstream budget when no one
 *   is watching.
 *
 * - **Adaptive cadence.** `every` is the default interval; the task's
 *   `run` may return `{ nextRun: '5s' | '30s' | '1h' }` to override the
 *   next tick.
 *
 * - **Coarse re-resolve.** After each run, `onTaskComplete(appId)` fires
 *   so the host can call `refreshAllFaces(appId)` and broadcast deltas.
 *   No per-task `writes` declarations needed at v1 scale.
 *
 * - **Failure tracking.** Per-task consecutive-failure counter + isFailing
 *   bit (true after 3 consecutive failures). Read via `getStaleness`.
 *
 * - **In-flight dedup.** Manual `invoke()` while a scheduled tick is in
 *   flight returns the same promise; never two concurrent runs of the
 *   same task.
 *
 * - **Stop semantics.** `stop()` cancels future ticks but lets in-flight
 *   runs finish (DB writes commit). Idempotent.
 *
 * Face-bound refresh (per `FaceDefinition.refresh`) is a separate concern;
 * it lands in step 9. This module is app-level only.
 */

import type {
  RefreshTaskDefinition,
  RefreshContext,
  RefreshResult,
  StalenessRecord,
  FaceBoundRefresh,
} from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One entry in the mounted-set: a single client's (deviceId) current view of
 * a face within a scope, with the params that face was mounted with.
 *
 * Multiple devices can have the same (scope, faceId, params) — face-bound
 * workers dedupe on (appId, faceId, paramsKey) so phone+watch viewing the
 * same `game(id=X)` share one worker.
 */
export interface MountedFaceEntry {
  deviceId: string
  /** 'app:<appId>' or 'home'. */
  scope: string
  faceId: string
  params: Record<string, unknown>
}

/**
 * Function returning the current mounted-set. The scheduler reads this on
 * every tick (for app-level mountedOnly gating) and on every reconcile
 * (for face-bound worker lifecycle).
 *
 * Injected so the scheduler is testable without WsServer; production
 * wiring (in step 10) uses WsServer's session state.
 */
export type MountedSetProvider = () => readonly MountedFaceEntry[]

export interface RefreshSchedulerDeps {
  /** Returns the current mounted-set. */
  getMountedSet: MountedSetProvider
  /**
   * Callback after a task's `run` completes (success or failure). The host
   * uses this to invoke `refreshAllFaces(appId)` so mounted clients see
   * delta updates from the new DB state. Fires for both app-level and
   * face-bound tasks.
   */
  onTaskComplete?: (appId: string, taskId: string, ok: boolean) => void
  /** Optional structured-log hook for telemetry. */
  log?: (event: { type: string; [k: string]: unknown }) => void
}

/** App-level context factory — supplies db/http/config/etc. for `run` invocations. */
export type AppContextFactory = () => Omit<RefreshContext, 'params'>

/** Face-bound context factory — same as app-level, plus the mount instance's params. */
export type FaceBoundContextFactory = (params: Record<string, unknown>) => RefreshContext

export interface RegisterAppOptions {
  appId: string
  tasks: RefreshTaskDefinition[]
  contextFactory: AppContextFactory
}

export interface RegisterFaceOptions {
  appId: string
  faceId: string
  refresh: FaceBoundRefresh
  contextFactory: FaceBoundContextFactory
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface TaskState {
  appId: string
  /** Public id used in getStaleness. App-level: spec.id. Face-bound: `${faceId}:${paramsKey}`. */
  taskId: string
  every: string
  warmup: boolean
  mountedOnly: boolean
  run: (ctx: RefreshContext) => Promise<RefreshResult | void>
  /** Returns the RefreshContext for one run. App-level passes nothing; face-bound passes params. */
  getCtx: () => RefreshContext
  // Face-bound only
  isFaceBound: boolean
  faceId?: string
  params?: Record<string, unknown>
  paramsKey?: string
  // Scheduling
  timer: ReturnType<typeof setTimeout> | null
  /** Promise of the in-flight run, if any. Multiple invokers await this. */
  inflight: Promise<void> | null
  // State exposed via getStaleness
  fetchedAt: number | null
  isFailing: boolean
  lastError: string | null
  consecutiveFailures: number
  /**
   * Last observed fingerprint from `RefreshResult.fingerprint`. Used to
   * short-circuit the `onTaskComplete` callback when two consecutive ticks
   * produce identical data — the DB upsert still runs (cheap when
   * unchanged) but no client sees a redundant faceUpdate broadcast.
   */
  lastFingerprint: string | null
}

interface FaceRegistrationState {
  refresh: FaceBoundRefresh
  contextFactory: FaceBoundContextFactory
}

/** Stable serialization of params for worker keying. */
function paramsKeyOf(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort()
  return JSON.stringify(keys.map((k) => [k, params[k]]))
}

const FAILURE_STREAK_THRESHOLD = 3

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class RefreshScheduler {
  private apps = new Map<string, TaskState[]>()
  /** appId → faceId → registration. Used for reconciliation. */
  private faceRegs = new Map<string, Map<string, FaceRegistrationState>>()
  /** workerKey = `${appId}:${faceId}:${paramsKey}`. Live face-bound workers. */
  private faceWorkers = new Map<string, TaskState>()
  private started = false

  constructor(private deps: RefreshSchedulerDeps) {}

  /**
   * Register (or replace) an app's refresh tasks. Existing tasks for this
   * app are stopped before re-registration. Does not start scheduling
   * automatically — call `start()` after registration, or `warmup(appId)`
   * to run warmup tasks once.
   */
  registerApp(opts: RegisterAppOptions): void {
    this.unregisterApp(opts.appId)
    const states = opts.tasks.map<TaskState>((spec) =>
      this.buildAppLevelState(opts.appId, spec, opts.contextFactory),
    )
    this.apps.set(opts.appId, states)
    if (this.started) {
      for (const s of states) this.scheduleNext(s, this.intervalMsOf(s.every))
    }
  }

  /** Stop and remove all tasks for the given app. In-flight runs complete. */
  unregisterApp(appId: string): void {
    const states = this.apps.get(appId)
    if (states) {
      for (const s of states) this.cancelTimer(s)
      this.apps.delete(appId)
    }
    // Also tear down all face-bound workers for this app.
    const regs = this.faceRegs.get(appId)
    if (regs) {
      for (const faceId of regs.keys()) {
        for (const [key, worker] of this.faceWorkers.entries()) {
          if (worker.appId === appId && worker.faceId === faceId) {
            this.cancelTimer(worker)
            this.faceWorkers.delete(key)
          }
        }
      }
      this.faceRegs.delete(appId)
    }
  }

  /**
   * Register a face-bound refresh. Per face, lives until the app
   * unregisters or the face is replaced. The actual worker(s) spawn on
   * the next reconciliation when matching mount entries appear.
   */
  registerFace(opts: RegisterFaceOptions): void {
    let regs = this.faceRegs.get(opts.appId)
    if (!regs) {
      regs = new Map()
      this.faceRegs.set(opts.appId, regs)
    }
    regs.set(opts.faceId, { refresh: opts.refresh, contextFactory: opts.contextFactory })
    if (this.started) this.reconcileFaceWorkers()
  }

  /** Unregister a face's refresh; kills all matching workers. */
  unregisterFace(appId: string, faceId: string): void {
    this.faceRegs.get(appId)?.delete(faceId)
    for (const [key, worker] of this.faceWorkers.entries()) {
      if (worker.appId === appId && worker.faceId === faceId) {
        this.cancelTimer(worker)
        this.faceWorkers.delete(key)
      }
    }
  }

  /**
   * Reconcile face-bound workers against the current mounted-set. Spawn
   * workers for new (faceId, params) keys; stop workers no longer matching
   * any mount. Call after any mounted-set change (mount, unmount, params
   * change).
   */
  notifyMountedSetChanged(): void {
    if (!this.started) return
    this.reconcileFaceWorkers()
  }

  /**
   * Run all `warmup: true` tasks for the given app once, awaiting completion.
   * Called at app boot before normal scheduling begins. Idempotent — safe
   * to call multiple times (each call performs a fresh run). App-level
   * tasks only; face-bound warmup happens when the worker spawns.
   */
  async warmup(appId: string): Promise<void> {
    const states = this.apps.get(appId)
    if (!states) return
    const warmupTasks = states.filter((s) => s.warmup)
    await Promise.all(warmupTasks.map((s) => this.runOnce(s)))
  }

  /** Begin scheduling all registered tasks (app-level + face-bound). Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const states of this.apps.values()) {
      for (const s of states) {
        if (s.timer === null) this.scheduleNext(s, this.intervalMsOf(s.every))
      }
    }
    this.reconcileFaceWorkers()
  }

  /** Stop all timers; in-flight runs finish. Idempotent. */
  stop(): void {
    this.started = false
    for (const states of this.apps.values()) {
      for (const s of states) this.cancelTimer(s)
    }
    for (const worker of this.faceWorkers.values()) {
      this.cancelTimer(worker)
    }
  }

  /**
   * Run a specific app-level task once on demand (used by manual-refresh
   * tools and `ctx.staleness(taskId).refresh`). If a run is already in
   * flight, returns the in-flight promise instead of starting a second one.
   */
  async invoke(appId: string, taskId: string): Promise<void> {
    const state = this.findTask(appId, taskId)
    if (!state) {
      throw new Error(`refresh-scheduler: unknown task "${taskId}" on app "${appId}"`)
    }
    return this.runOnce(state)
  }

  /**
   * Run a face-bound task once for a specific (faceId, params) instance.
   * If no worker exists for that key, throws.
   */
  async invokeFace(appId: string, faceId: string, params: Record<string, unknown>): Promise<void> {
    const key = `${appId}:${faceId}:${paramsKeyOf(params)}`
    const worker = this.faceWorkers.get(key)
    if (!worker) {
      throw new Error(`refresh-scheduler: no face-bound worker for ${key}`)
    }
    return this.runOnce(worker)
  }

  /** Per-task staleness record — used by `ctx.staleness(taskId)`. */
  getStaleness(appId: string, taskId: string): StalenessRecord {
    const state = this.findTask(appId, taskId)
    if (!state) {
      throw new Error(`refresh-scheduler: unknown task "${taskId}" on app "${appId}"`)
    }
    return {
      fetchedAt: state.fetchedAt,
      isFailing: state.isFailing,
      lastError: state.lastError,
      refresh: () => this.invoke(appId, taskId),
    }
  }

  /** Staleness for a face-bound worker, looked up by (faceId, params). */
  getFaceStaleness(
    appId: string,
    faceId: string,
    params: Record<string, unknown>,
  ): StalenessRecord {
    const key = `${appId}:${faceId}:${paramsKeyOf(params)}`
    const worker = this.faceWorkers.get(key)
    if (!worker) {
      throw new Error(`refresh-scheduler: no face-bound worker for ${key}`)
    }
    return {
      fetchedAt: worker.fetchedAt,
      isFailing: worker.isFailing,
      lastError: worker.lastError,
      refresh: () => this.runOnce(worker),
    }
  }

  /**
   * Pre-mount-tolerant variant of `getFaceStaleness`. Returns null when
   * no worker exists yet (face just mounted, scheduler still warming up,
   * resolver running before the first reconcile). Used by the framework's
   * `selfStaleness?()` accessor on FaceResolve so authors can render an
   * "Updating…" placeholder without guarding against throws.
   */
  getFaceStalenessOrNull(
    appId: string,
    faceId: string,
    params: Record<string, unknown>,
  ): StalenessRecord | null {
    const key = `${appId}:${faceId}:${paramsKeyOf(params)}`
    const worker = this.faceWorkers.get(key)
    if (!worker) return null
    return {
      fetchedAt: worker.fetchedAt,
      isFailing: worker.isFailing,
      lastError: worker.lastError,
      refresh: () => this.runOnce(worker),
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private buildAppLevelState(
    appId: string,
    spec: RefreshTaskDefinition,
    ctxFactory: AppContextFactory,
  ): TaskState {
    return {
      appId,
      taskId: spec.id,
      every: spec.every,
      warmup: spec.warmup ?? false,
      mountedOnly: spec.mountedOnly ?? true,
      run: spec.run,
      getCtx: () => ctxFactory() as RefreshContext,
      isFaceBound: false,
      timer: null,
      inflight: null,
      fetchedAt: null,
      isFailing: false,
      lastError: null,
      consecutiveFailures: 0,
      lastFingerprint: null,
    }
  }

  private buildFaceState(
    appId: string,
    faceId: string,
    params: Record<string, unknown>,
    paramsKey: string,
    reg: FaceRegistrationState,
  ): TaskState {
    return {
      appId,
      taskId: `${faceId}:${paramsKey}`,
      every: reg.refresh.every,
      warmup: reg.refresh.warmup ?? true,
      mountedOnly: true, // face-bound is intrinsically mounted-only
      run: reg.refresh.run,
      getCtx: () => reg.contextFactory(params),
      isFaceBound: true,
      faceId,
      params,
      paramsKey,
      timer: null,
      inflight: null,
      fetchedAt: null,
      isFailing: false,
      lastError: null,
      consecutiveFailures: 0,
      lastFingerprint: null,
    }
  }

  /**
   * Compare current mounted-set against live face workers; spawn for new
   * keys, stop workers no longer present.
   */
  private reconcileFaceWorkers(): void {
    if (this.faceRegs.size === 0) return
    const mounted = this.deps.getMountedSet()

    // Build desired worker set: { workerKey → params }
    const desired = new Map<
      string,
      { appId: string; faceId: string; params: Record<string, unknown>; reg: FaceRegistrationState }
    >()
    for (const m of mounted) {
      const appPrefix = 'app:'
      if (!m.scope.startsWith(appPrefix)) continue
      const appId = m.scope.slice(appPrefix.length)
      const reg = this.faceRegs.get(appId)?.get(m.faceId)
      if (!reg) continue
      const paramsKey = paramsKeyOf(m.params)
      const workerKey = `${appId}:${m.faceId}:${paramsKey}`
      if (!desired.has(workerKey)) {
        desired.set(workerKey, { appId, faceId: m.faceId, params: m.params, reg })
      }
    }

    // Spawn missing workers
    for (const [key, info] of desired.entries()) {
      if (this.faceWorkers.has(key)) continue
      const paramsKey = paramsKeyOf(info.params)
      const state = this.buildFaceState(info.appId, info.faceId, info.params, paramsKey, info.reg)
      this.faceWorkers.set(key, state)
      // Optional warmup run (one-shot), then schedule
      if (state.warmup) {
        void this.runOnce(state).then(() => {
          if (this.faceWorkers.get(key) === state) {
            this.scheduleNext(state, this.intervalMsOf(state.every))
          }
        })
      } else {
        this.scheduleNext(state, this.intervalMsOf(state.every))
      }
    }

    // Stop workers no longer in the desired set
    for (const [key, worker] of this.faceWorkers.entries()) {
      if (desired.has(key)) continue
      this.cancelTimer(worker)
      this.faceWorkers.delete(key)
    }
  }

  private findTask(appId: string, taskId: string): TaskState | undefined {
    return this.apps.get(appId)?.find((s) => s.taskId === taskId)
  }

  private cancelTimer(s: TaskState): void {
    if (s.timer !== null) {
      clearTimeout(s.timer)
      s.timer = null
    }
  }

  private scheduleNext(s: TaskState, delayMs: number): void {
    if (!this.started) return
    this.cancelTimer(s)
    s.timer = setTimeout(() => {
      void this.tick(s)
    }, delayMs)
    // Allow process to exit if this is the only thing keeping it alive.
    s.timer.unref?.()
  }

  /** A scheduled tick — gates on mounted-set, then runs (or skips). */
  private async tick(s: TaskState): Promise<void> {
    s.timer = null
    if (!this.shouldTick(s)) {
      // For face-bound workers, a missing mount means reconcile will stop us;
      // otherwise stay scheduled at the default interval.
      if (s.isFaceBound) return
      this.scheduleNext(s, this.intervalMsOf(s.every))
      return
    }
    try {
      await this.runOnce(s)
    } finally {
      // Reschedule (nextRun override may already be set); skip if worker was killed.
      if (this.started && s.timer === null && this.isStillLive(s)) {
        this.scheduleNext(s, this.intervalMsOf(s.every))
      }
    }
  }

  private shouldTick(s: TaskState): boolean {
    if (!s.mountedOnly) return true
    const mounted = this.deps.getMountedSet()
    if (s.isFaceBound) {
      // Face-bound: this exact (faceId, paramsKey) must still be mounted.
      const wantedKey = s.paramsKey!
      for (const m of mounted) {
        if (m.scope !== `app:${s.appId}`) continue
        if (m.faceId !== s.faceId) continue
        if (paramsKeyOf(m.params) === wantedKey) return true
      }
      return false
    }
    // App-level: any face from this app's scope mounted is enough.
    for (const m of mounted) {
      if (m.scope === `app:${s.appId}`) return true
    }
    return false
  }

  /** True if the worker is still in either app-level state list or the face workers map. */
  private isStillLive(s: TaskState): boolean {
    if (s.isFaceBound) {
      const key = `${s.appId}:${s.faceId}:${s.paramsKey}`
      return this.faceWorkers.get(key) === s
    }
    return (this.apps.get(s.appId) ?? []).includes(s)
  }

  /** Execute the task body once, dedupe concurrent invokers, update state. */
  private async runOnce(s: TaskState): Promise<void> {
    if (s.inflight) return s.inflight
    s.inflight = this.runOnceImpl(s).finally(() => {
      s.inflight = null
    })
    return s.inflight
  }

  private async runOnceImpl(s: TaskState): Promise<void> {
    const startedAt = Date.now()
    let result: RefreshResult | void = undefined
    let ok = true
    try {
      const ctx = s.getCtx()
      result = await s.run(ctx)
      s.fetchedAt = Math.floor(Date.now() / 1000)
      s.lastError = null
      s.consecutiveFailures = 0
      s.isFailing = false
    } catch (err) {
      ok = false
      s.lastError = err instanceof Error ? err.message : String(err)
      s.consecutiveFailures += 1
      if (s.consecutiveFailures >= FAILURE_STREAK_THRESHOLD) s.isFailing = true
      this.deps.log?.({
        type: 'refresh_task_error',
        appId: s.appId,
        taskId: s.taskId,
        consecutiveFailures: s.consecutiveFailures,
        error: s.lastError,
      })
    }

    this.deps.log?.({
      type: 'refresh_task_complete',
      appId: s.appId,
      taskId: s.taskId,
      ok,
      latencyMs: Date.now() - startedAt,
    })

    // nextRun override on success only — failures stick to `every` to avoid hot-loop.
    if (ok && result && typeof result === 'object' && 'nextRun' in result && result.nextRun) {
      const nextMs = this.intervalMsOf(result.nextRun)
      this.scheduleNext(s, nextMs)
    }

    // Fingerprint short-circuit: skip onTaskComplete when the fingerprint matches
    // the prior tick's — saves resolver work + wire bytes for unchanged payloads.
    // Failure ticks always notify (host surfaces staleness UI).
    let skipNotify = false
    if (
      ok &&
      result &&
      typeof result === 'object' &&
      'fingerprint' in result &&
      typeof result.fingerprint === 'string'
    ) {
      if (s.lastFingerprint !== null && s.lastFingerprint === result.fingerprint) {
        skipNotify = true
      }
      s.lastFingerprint = result.fingerprint
    }

    if (skipNotify) {
      this.deps.log?.({
        type: 'refresh_task_unchanged',
        appId: s.appId,
        taskId: s.taskId,
      })
      return
    }

    // Notify the host — typically wires to refreshAllFaces(appId).
    try {
      this.deps.onTaskComplete?.(s.appId, s.taskId, ok)
    } catch (err) {
      this.deps.log?.({
        type: 'refresh_on_complete_error',
        appId: s.appId,
        taskId: s.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Parse 'NNs' / 'NNm' / 'NNh' to milliseconds. Defaults to 30s on bad input. */
  private intervalMsOf(every: string): number {
    const m = /^(\d+)(s|m|h)$/.exec(every)
    if (!m) return 30_000
    const n = parseInt(m[1]!, 10)
    switch (m[2]) {
      case 's':
        return n * 1_000
      case 'm':
        return n * 60_000
      case 'h':
        return n * 3_600_000
      default:
        return 30_000
    }
  }
}
