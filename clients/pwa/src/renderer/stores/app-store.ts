/**
 * Zustand store for the 2D app/face navigation model.
 * Apps are arranged horizontally; each app has a vertical face stack.
 * Chat is an overlay per app.
 */

import { create } from 'zustand'
import type {
  ComponentDef,
  AppInfo,
  FaceInfo,
  DraftSummary,
} from '@moumantai/protocol/generated/moumantai/v1'
import { AppVariant } from '@moumantai/protocol/generated/moumantai/v1'
import { setAtPointer } from '../data-model'

// ---------------------------------------------------------------------------
// localStorage helpers for previewingDraft persistence
// ---------------------------------------------------------------------------

const LS_PREVIEWING_KEY = 'moumantai.previewingDraft'

function loadPreviewingDraft(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_PREVIEWING_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed as string[])
  } catch {
    // ignore malformed storage
  }
  return new Set()
}

function savePreviewingDraft(set: Set<string>): void {
  try {
    localStorage.setItem(LS_PREVIEWING_KEY, JSON.stringify([...set]))
  } catch {
    // ignore storage errors (e.g. private browsing quota)
  }
}

/**
 * Proximity cache radius: keep face data for apps within this many carousel
 * slots of active. Matches the server's neighbor-prefetch radius.
 * radius=1 → 3 apps cached (active + one each side).
 */
export const NEIGHBOR_WINDOW = 1

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface FaceState {
  faceId: string
  label: string
  position: number
  components: Map<string, ComponentDef>
  data: Record<string, unknown>
  /**
   * Per-face form scope. TextField/Slider/Select/CheckBox/Switch with no
   * `action` write their values here on change. Survives face refreshes
   * (server never authors `$form`); cleared when the user navigates away
   * from the face. Action `args` reference values via `pathRef('/$form/<id>')`
   * which the dispatcher resolves at send time.
   */
  form: Record<string, unknown>
}

export interface AppState {
  appId: string
  label: string
  icon: string
  position: number
  /**
   * Optional M3 brand seed hex (e.g. `"#4CAF50"`). Absent when the manifest
   * doesn't declare `color`; falls back to the Moumantai default.
   */
  themeSeed: string | undefined
  /** True for new-app draft entries (variant=DRAFT, kind=NEW_APP) — the PWA
   *  hides the chat FAB since there's no live agent chat for an unpromoted app. */
  chatDisabled: boolean
  faces: Map<string, FaceState>
  faceOrder: string[] // sorted by position
  activeFaceIndex: number // per-app vertical position
}

interface AppStoreState {
  apps: Map<string, AppState>
  appOrder: string[] // sorted by position, home always 0
  activeAppIndex: number // horizontal position
  chatOverlay: { appId: string; open: boolean } | null

  /**
   * Draft ids this client has opted in to preview. Persisted to
   * `localStorage.moumantai.previewingDraft` (JSON array).
   */
  previewingDraft: Set<string>

  /** Latest summaries for known drafts, keyed by draftId. */
  drafts: Map<string, DraftSummary>

  // Actions
  setAppList: (apps: AppInfo[]) => void
  setFaceList: (appId: string, faces: FaceInfo[]) => void
  updateFace: (
    appId: string,
    faceId: string,
    components: ComponentDef[],
    data: Record<string, unknown>,
  ) => void
  setActiveAppIndex: (index: number) => void
  /**
   * Drop face `components`+`data` for apps farther than `window` carousel
   * slots from `activeIndex`. Preserves the per-face `form` scope (drafts)
   * and the `faces`/`faceOrder` metadata so the pager still renders labels.
   * Caller is expected to follow up with a `sendViewing` for the new active
   * scope; the server's prefetch re-fills the neighbors.
   */
  evictInactiveApps: (activeIndex: number, window: number) => void
  setActiveFaceIndex: (appId: string, index: number) => void
  navigateTo: (appId: string, faceId?: string) => void
  setChatOverlay: (appId: string, open: boolean) => void
  setFaceDataAtPath: (appId: string, faceId: string, path: string, value: unknown) => void
  /**
   * Set a value in the per-face `$form` scope. Used by inputs without an
   * `action` to write user-typed/dragged values that survive face refreshes
   * but never round-trip until a submit fires.
   */
  setFormValue: (appId: string, faceId: string, key: string, value: unknown) => void
  /**
   * Toggle opt-in/opt-out for a draft preview. Mutates `previewingDraft` and
   * rewrites `localStorage.moumantai.previewingDraft`.
   */
  setPreviewingDraft: (draftId: string, optIn: boolean) => void

  /**
   * Insert or replace the summary for a draft (fed by DraftStateChanged).
   */
  upsertDraft: (summary: DraftSummary) => void

  /**
   * Remove a draft from `drafts` and prune it from `previewingDraft` +
   * localStorage. Called when the server reports a draft was promoted or
   * discarded.
   */
  removeDraft: (draftId: string) => void

  getActiveAppId: () => string | undefined
  getActiveFaceId: (appId: string) => string | undefined
  reset: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppStoreState>((set, get) => ({
  apps: new Map(),
  appOrder: [],
  activeAppIndex: 0,
  chatOverlay: null,
  previewingDraft: loadPreviewingDraft(),
  drafts: new Map(),

  setAppList: (apps) =>
    set((state) => {
      const liveApps = apps.filter((a) => a.variant !== AppVariant.DRAFT)
      const draftApps = apps.filter((a) => a.variant === AppVariant.DRAFT)
      const sorted = [
        ...[...liveApps].sort((a, b) => a.position - b.position),
        ...[...draftApps].sort((a, b) => a.position - b.position),
      ]
      // Preserve the current position so a new AppListMsg (e.g. draft appearing)
      // doesn't snap the carousel back to index 0.
      const currentAppId = state.appOrder[state.activeAppIndex]
      const appMap = new Map<string, AppState>()
      const order: string[] = []
      for (const info of sorted) {
        // Preserve per-app state (faces, faceOrder, activeFaceIndex) across list
        // updates — only refresh descriptor fields. Without this, every AppListMsg
        // would blank all faces until the server re-pushes them.
        const prev = state.apps.get(info.appId)
        appMap.set(info.appId, {
          appId: info.appId,
          label: info.label,
          icon: info.icon,
          position: info.position,
          themeSeed: info.themeSeed || undefined,
          chatDisabled: info.chatDisabled ?? false,
          faces: prev?.faces ?? new Map(),
          faceOrder: prev?.faceOrder ?? [],
          activeFaceIndex: prev?.activeFaceIndex ?? 0,
        })
        order.push(info.appId)
      }
      const reIndex = currentAppId ? order.indexOf(currentAppId) : -1
      const activeAppIndex = reIndex >= 0 ? reIndex : 0
      return { apps: appMap, appOrder: order, activeAppIndex }
    }),

  setFaceList: (appId, faces) =>
    set((state) => {
      const apps = new Map(state.apps)
      const app = apps.get(appId)
      if (!app) return state
      const sorted = [...faces].sort((a, b) => a.position - b.position)
      const faceOrder = sorted.map((f) => f.faceId)
      // Initialize face entries (keep existing data if face already exists)
      const faceMap = new Map(app.faces)
      for (const info of sorted) {
        if (!faceMap.has(info.faceId)) {
          faceMap.set(info.faceId, {
            faceId: info.faceId,
            label: info.label,
            position: info.position,
            components: new Map(),
            data: {},
            form: {},
          })
        }
      }
      apps.set(appId, { ...app, faces: faceMap, faceOrder })
      return { apps }
    }),

  updateFace: (appId, faceId, components, data) =>
    set((state) => {
      const apps = new Map(state.apps)
      const app = apps.get(appId)
      if (!app) return state
      const faces = new Map(app.faces)
      const compMap = new Map<string, ComponentDef>()
      for (const comp of components) {
        compMap.set(comp.id, comp)
      }
      const existing = faces.get(faceId)
      // Preserve `form` across refreshes — server data overwrites `data`,
      // but `$form` is client-owned.
      faces.set(faceId, {
        faceId,
        label: existing?.label ?? faceId,
        position: existing?.position ?? 0,
        components: compMap,
        data,
        form: existing?.form ?? {},
      })
      apps.set(appId, { ...app, faces })
      return { apps }
    }),

  setActiveAppIndex: (index) =>
    set((state) => {
      if (index < 0 || index >= state.appOrder.length) return state
      return { activeAppIndex: index }
    }),

  evictInactiveApps: (activeIndex, window) =>
    set((state) => {
      if (state.appOrder.length === 0) return state
      const nextApps = new Map(state.apps)
      let changed = false
      state.appOrder.forEach((appId, i) => {
        if (Math.abs(i - activeIndex) <= window) return
        const app = nextApps.get(appId)
        if (!app || app.faces.size === 0) return
        let appChanged = false
        const nextFaces = new Map<string, FaceState>()
        app.faces.forEach((face, fid) => {
          if (face.components.size === 0 && Object.keys(face.data).length === 0) {
            nextFaces.set(fid, face)
            return
          }
          appChanged = true
          // Drop server-authored components+data; preserve `form` (client-owned).
          nextFaces.set(fid, { ...face, components: new Map(), data: {} })
        })
        if (appChanged) {
          changed = true
          nextApps.set(appId, { ...app, faces: nextFaces })
        }
      })
      return changed ? { apps: nextApps } : state
    }),

  setActiveFaceIndex: (appId, index) =>
    set((state) => {
      const apps = new Map(state.apps)
      const app = apps.get(appId)
      if (!app) return state
      if (index < 0 || index >= app.faceOrder.length) return state
      // Clear `$form` of the face we're leaving — drafts don't survive nav.
      const leaving = app.faceOrder[app.activeFaceIndex]
      const faces = new Map(app.faces)
      if (leaving && leaving !== app.faceOrder[index]) {
        const face = faces.get(leaving)
        if (face && Object.keys(face.form).length > 0) {
          faces.set(leaving, { ...face, form: {} })
        }
      }
      apps.set(appId, { ...app, faces, activeFaceIndex: index })
      return { apps }
    }),

  navigateTo: (appId, faceId) =>
    set((state) => {
      const appIndex = state.appOrder.indexOf(appId)
      if (appIndex === -1) return state
      const updates: Partial<AppStoreState> = { activeAppIndex: appIndex }
      if (faceId) {
        const apps = new Map(state.apps)
        const app = apps.get(appId)
        if (app) {
          const faceIndex = app.faceOrder.indexOf(faceId)
          if (faceIndex !== -1) {
            // Clear `$form` of the face we're leaving.
            const leaving = app.faceOrder[app.activeFaceIndex]
            const faces = new Map(app.faces)
            if (leaving && leaving !== faceId) {
              const face = faces.get(leaving)
              if (face && Object.keys(face.form).length > 0) {
                faces.set(leaving, { ...face, form: {} })
              }
            }
            apps.set(appId, { ...app, faces, activeFaceIndex: faceIndex })
            updates.apps = apps
          }
        }
      }
      return updates
    }),

  setChatOverlay: (appId, open) =>
    set(() => ({
      chatOverlay: open ? { appId, open } : null,
    })),

  setFaceDataAtPath: (appId, faceId, path, value) =>
    set((state) => {
      const apps = new Map(state.apps)
      const app = apps.get(appId)
      if (!app) return state
      const faces = new Map(app.faces)
      const face = faces.get(faceId)
      if (!face) return state
      const data = setAtPointer(face.data, path, value) as Record<string, unknown>
      faces.set(faceId, { ...face, data })
      apps.set(appId, { ...app, faces })
      return { apps }
    }),

  setFormValue: (appId, faceId, key, value) =>
    set((state) => {
      const apps = new Map(state.apps)
      const app = apps.get(appId)
      if (!app) return state
      const faces = new Map(app.faces)
      const face = faces.get(faceId)
      if (!face) return state
      faces.set(faceId, { ...face, form: { ...face.form, [key]: value } })
      apps.set(appId, { ...app, faces })
      return { apps }
    }),

  setPreviewingDraft: (draftId, optIn) =>
    set((state) => {
      const next = new Set(state.previewingDraft)
      if (optIn) {
        next.add(draftId)
      } else {
        next.delete(draftId)
      }
      savePreviewingDraft(next)
      return { previewingDraft: next }
    }),

  upsertDraft: (summary) =>
    set((state) => {
      const next = new Map(state.drafts)
      next.set(summary.draftId, summary)
      return { drafts: next }
    }),

  removeDraft: (draftId) =>
    set((state) => {
      const nextDrafts = new Map(state.drafts)
      nextDrafts.delete(draftId)
      const nextPreviewing = new Set(state.previewingDraft)
      if (nextPreviewing.has(draftId)) {
        nextPreviewing.delete(draftId)
        savePreviewingDraft(nextPreviewing)
        return { drafts: nextDrafts, previewingDraft: nextPreviewing }
      }
      return { drafts: nextDrafts }
    }),

  getActiveAppId: () => {
    const state = get()
    return state.appOrder[state.activeAppIndex]
  },

  getActiveFaceId: (appId) => {
    const state = get()
    const app = state.apps.get(appId)
    if (!app) return undefined
    return app.faceOrder[app.activeFaceIndex]
  },

  reset: () =>
    set({ apps: new Map(), appOrder: [], activeAppIndex: 0, chatOverlay: null, drafts: new Map() }),
}))
