/**
 * Broadcast helpers for pushing app/face updates to WS clients.
 *
 * Face/app frames are resolved PER CLIENT when drafts are active: a client that
 * has opted into previewing a draft sees the draft variant (resolved from the
 * DraftRegistry's booted shadow app, tagged `variant=DRAFT`); everyone else
 * sees live. When no draft is active the cheap single-broadcast fast path is
 * preserved.
 *
 * All outbound messages are typed `ServerMessage` envelopes built via the
 * helpers in `transport/messages.ts`.
 */

import type { AppEngine, BootedApp } from './app-engine.js'
import type {
  DeviceClass,
  ServerMessage,
  SizeClass,
} from '@moumantai/protocol/generated/moumantai/v1'
import { AppVariant } from '@moumantai/protocol/generated/moumantai/v1'
import type { DraftRegistry } from '../drafts/draft-registry.js'
import { filterComponentsForDevice } from '../protocol/catalog.js'
import { msgAppList, msgFaceList, msgFaceUpdate } from '../transport/messages.js'
import { appIdToScope } from '@moumantai/protocol'

/**
 * Per-live-connection metadata broadcast paths need (sizeClass for variant
 * selection, deviceClass for component filtering, sessionId for routing, and
 * the set of drafts this client is previewing).
 * The shape WsServer.getLiveConnections() returns satisfies this.
 */
export interface BroadcastClient {
  sessionId: string
  deviceClass: DeviceClass
  sizeClass: SizeClass
  /** Draft ids this client has opted into previewing (PWA dev mode only). */
  previewingDraft?: ReadonlySet<string>
}

export interface BroadcastTransport {
  broadcast(message: ServerMessage): void
  send(sessionId: string, message: ServerMessage): void
  /**
   * Per-device focus mutation. Persists `(deviceId → appId/faceId)` to
   * the devices table (server-SSOT for active view) AND pushes a Navigate
   * frame to the live device if it's currently connected.
   *
   * Optional on the interface so test fakes can omit it; navigate-driving
   * call sites must check before invoking.
   */
  setDeviceFocus?(deviceId: string, appId: string, faceId?: string): void
}

/**
 * Canonical mapping from app manifests to wire `AppInfo`. Both `broadcastAppList`
 * and `sendInitialState` (main.ts) must use this to keep the initial connect and
 * later broadcasts in sync — notably `themeSeed`, whose omission left the M3
 * palette stuck on the default until an unrelated broadcast landed.
 */
export function liveAppEntries(appEngine: AppEngine) {
  return appEngine.listApps().map((m, i) => ({
    appId: m.id,
    label: m.name,
    icon: m.icon,
    position: i,
    // Per-app M3 brand seed (hex); omitted apps fall back to the default.
    themeSeed: m.color,
  }))
}

/**
 * Broadcast the current app list. When new-app drafts exist AND a per-client
 * list is provided, opted-in clients additionally receive booted new-app draft
 * entries (`variant=DRAFT`, `chat_disabled`) appended after the live apps.
 * Edit drafts do NOT add list entries — they surface via the per-client face variant.
 */
export function broadcastAppList(
  transport: BroadcastTransport,
  appEngine: AppEngine,
  clients?: ReadonlyArray<BroadcastClient>,
  draftRegistry?: DraftRegistry,
): void {
  const liveApps = liveAppEntries(appEngine)

  const newAppDrafts = (draftRegistry?.listNewAppDrafts() ?? []).filter((d) => d.booted)
  if (newAppDrafts.length === 0 || !clients) {
    transport.broadcast(msgAppList({ apps: liveApps }))
    return
  }

  for (const client of clients) {
    const draftEntries = newAppDrafts
      .filter((d) => client.previewingDraft?.has(d.draftId))
      .map((d, i) => ({
        appId: d.appId,
        label: d.booted.manifest.name,
        icon: d.booted.manifest.icon,
        position: liveApps.length + i,
        themeSeed: d.booted.manifest.color,
        variant: AppVariant.DRAFT,
        draftId: d.draftId,
        chatDisabled: true,
      }))
    transport.send(client.sessionId, msgAppList({ apps: [...liveApps, ...draftEntries] }))
  }
}

/** The booted app + variant tag a given client should render for `appId`. */
function resolveForClient(
  client: BroadcastClient,
  liveApp: BootedApp | undefined,
  draftsForApp: ReadonlyArray<{ draftId: string; booted: BootedApp }>,
): { booted: BootedApp; variant?: AppVariant } | null {
  const draft = draftsForApp.find((d) => d.booted && client.previewingDraft?.has(d.draftId))
  if (draft) return { booted: draft.booted, variant: AppVariant.DRAFT }
  if (liveApp) return { booted: liveApp } // variant unset == LIVE
  return null
}

/**
 * Broadcast faceList + faceUpdate for a single app. Per-client variant routing
 * kicks in only when a draft shadows `appId`; otherwise the existing cheap path
 * (single faceList broadcast + per-client faceUpdate) is used unchanged.
 *
 * `paramsByFaceId` resolves parameterized faces with persisted view-state;
 * callers load it under the appropriate key (the draftId for draft previews).
 */
export function broadcastFaces(
  transport: BroadcastTransport,
  appEngine: AppEngine,
  appId: string,
  clients?: ReadonlyArray<BroadcastClient>,
  paramsByFaceId?: Record<string, Record<string, unknown>>,
  draftRegistry?: DraftRegistry,
): void {
  const liveApp = appEngine.getApp(appId)
  const draftsForApp = (draftRegistry?.listActiveDrafts() ?? [])
    .filter((d) => d.appId === appId && d.booted)
    .map((d) => ({ draftId: d.draftId, booted: d.booted }))
  const anyDraft = draftsForApp.length > 0

  if (!liveApp && !anyDraft) return
  const scope = appIdToScope(appId)
  const params = paramsByFaceId ?? {}

  const renderFor = (booted: BootedApp, client: BroadcastClient, variant?: AppVariant): void => {
    const resolveDeps = { db: booted.db, paramsByFaceId: params, context: booted.context }
    for (const face of booted.faceRegistry.list()) {
      const selected = booted.faceRegistry.selectForSize(face.id, client.sizeClass)
      const data = booted.faceRegistry.resolveOne(face.id, resolveDeps)
      const components = filterComponentsForDevice(selected.components, client.deviceClass)
      transport.send(
        client.sessionId,
        msgFaceUpdate({ scope, appId, faceId: face.id, components, data, variant }),
      )
    }
  }

  // No draft for this app → preserve the fast path (single faceList broadcast,
  // per-client faceUpdate live, no variant tagging).
  if (!anyDraft) {
    if (!liveApp) return
    transport.broadcast(
      msgFaceList({
        appId,
        faces: liveApp.faceRegistry
          .list()
          .map((f) => ({ faceId: f.id, label: f.label, position: f.position })),
      }),
    )
    if (clients) {
      for (const client of clients) renderFor(liveApp, client, undefined)
    } else {
      // Fallback: no per-client list — default render to all.
      const resolveDeps = { db: liveApp.db, paramsByFaceId: params, context: liveApp.context }
      for (const face of liveApp.faceRegistry.list()) {
        const data = liveApp.faceRegistry.resolveOne(face.id, resolveDeps)
        transport.broadcast(
          msgFaceUpdate({ scope, appId, faceId: face.id, components: face.components, data }),
        )
      }
    }
    return
  }

  // A draft shadows this app — resolve faceList + faceUpdate per client so the
  // draft's (possibly different) face set + variant reach only opted-in clients.
  if (!clients) {
    // No per-client context: a draft can't be routed; fall back to live.
    if (!liveApp) return
    transport.broadcast(
      msgFaceList({
        appId,
        faces: liveApp.faceRegistry
          .list()
          .map((f) => ({ faceId: f.id, label: f.label, position: f.position })),
      }),
    )
    const resolveDeps = { db: liveApp.db, paramsByFaceId: params, context: liveApp.context }
    for (const face of liveApp.faceRegistry.list()) {
      const data = liveApp.faceRegistry.resolveOne(face.id, resolveDeps)
      transport.broadcast(
        msgFaceUpdate({ scope, appId, faceId: face.id, components: face.components, data }),
      )
    }
    return
  }

  for (const client of clients) {
    const resolved = resolveForClient(client, liveApp, draftsForApp)
    if (!resolved) continue
    const { booted, variant } = resolved
    transport.send(
      client.sessionId,
      msgFaceList({
        appId,
        faces: booted.faceRegistry
          .list()
          .map((f) => ({ faceId: f.id, label: f.label, position: f.position })),
      }),
    )
    renderFor(booted, client, variant)
  }
}
