/**
 * Moumantai v1-persistence standalone server entry point.
 *
 * Wires together: HTTP server, WS transport, App Engine, persistent
 * ConversationStore, LLM adapter (claude), voice relay, and agent loop.
 *
 * Boot sequence:
 *   1. Resolve home + open platform.db (chat SSOT)
 *   2. Create WS server, turn queue, client manager
 *   3. Create ConversationStore(db) + subscribe to its event bus →
 *      broadcast `chat` / `chatWindow` via wsServer.broadcastToScope
 *   4. Create LLM adapter + voice relay
 *   5. Create AppEngine with {home, store, turnQueue, ...}, register
 *      built-in + plugin apps, eager-boot `home`, start idle sweeper
 *   6. Wire home tools (delegation, app list, navigate)
 *   7. Wire WS callbacks (connect, viewing, chatInput, audioInput, reset, …)
 *   8. Start listening + graceful shutdown
 */

import { createServer } from 'http'
import fs from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { loadConfig } from './config.js'

// Hot-reload: entry URLs are cache-busted with `?v=<t>`; supplemental-scan
// and LLM-generated files use `?t=<t>`. Cache-busting does NOT propagate to
// transitive imports — editing parts.ts, schema.ts, etc. requires touching
// the entry or restarting. See server/CLAUDE.md.
import type { ServerConfig } from './config.js'
import { WsServer } from './transport/ws-server.js'
import { audioChunkHeader, encodeAudioFrame } from '@moumantai/protocol'
import {
  AppVariant,
  AudioFormat,
  ChatKind,
  DeviceClass,
  DraftStatus,
  ProtocolErrorCode,
  SizeClass,
  VoiceStateValue,
} from '@moumantai/protocol/generated/moumantai/v1'
import type { HelloNavIntent } from './transport/ws-server.js'
import type { ChatWindowEntryInit } from './transport/messages.js'
import { filterComponentsForDevice } from './protocol/catalog.js'
import { VoiceRelay, type VoiceRelayEvent } from './voice/relay.js'
import type { AudioService } from './voice/audio-service.js'
import { MockAudioService } from './voice/mock-audio.js'
import { AppEngine, getToolSchemas } from './agent/app-engine.js'
import { AgentLoop } from './agent/agent-loop.js'
import { TurnQueue } from './agent/turn-queue.js'
import {
  handleInvokeTool,
  clearPendingEscalation,
  clearPendingEscalationsByScope,
} from './agent/action-handler.js'
import { DedupStore, startDedupSweep } from './agent/dedup-store.js'
import { runDelegation } from './agent/delegation.js'
import { runBoundTurn, sdkResumeArgs } from './agent/bound-turn.js'
import type { Attachment, LLMAdapter } from './agent/types.js'
import { refreshAllFaces, type SendFaceUpdate } from './agent/face-refresh.js'
import { ClaudeAgentAdapter, isAnthropicImageMime } from './agent/claude/adapter.js'
import { createHomeDef, wireHomeTools } from './apps/home/index.js'
import {
  loadApps,
  reloadSingleApp,
  discoverApps,
  applySupplementalScan,
  findEntryFile,
} from './agent/app-loader.js'
import { FaceRegistry } from './agent/face-loader.js'
import type { DraftMeta } from './drafts/types.js'
import type { ChatInput } from '@moumantai/protocol/generated/moumantai/v1'
import { AppFileWatcher, appDirToName } from './agent/file-watcher.js'
import {
  broadcastAppList,
  broadcastFaces,
  liveAppEntries,
  type BroadcastTransport,
} from './agent/broadcast.js'
import { wireSynthFaceTools } from './agent/synthesize-face-tool.js'
import { synthesizeUpdateContextTool } from './agent/synthesize-update-context-tool.js'
import { createHttpClient } from './framework/http-client.js'
import { createAssetCache, tryServeAssetRequest } from './framework/asset-cache.js'
import { vacuumIfIdle } from './db/maintenance.js'
import { RefreshScheduler } from './agent/refresh-scheduler.js'
import { loadAppContext, setContextField } from './framework/app-context.js'
import type { RefreshContext } from './agent/types.js'
import { FaceParamsStore } from './agent/face-params-store.js'
import { buildFaceContext } from './agent/face-context.js'
import {
  msgAppList,
  msgFaceList,
  msgFaceUpdate,
  msgChat,
  msgChatWindow,
  msgChatHistory,
  msgChatUpdate,
  msgResetNotice,
  msgVoiceState,
  msgNavigate,
  msgError,
  msgUiActionEscalated,
  msgDraftStateChanged,
  msgDraftActionResult,
  msgChatTodosUpdate,
} from './transport/messages.js'
import { DraftRegistry } from './drafts/draft-registry.js'
import { DraftStore } from './drafts/draft-store.js'
import { promotions } from './drafts/promotions-schema.js'
import { buildEditAgentRequest } from './agent/edit-session.js'
import { openPlatformDb } from './db/platform-db.js'
import { ConversationStore } from './conversations/store.js'
import { scopeToAppId, appIdToScope } from '@moumantai/protocol'
import type { Message } from './conversations/schema.js'
import { homeLayout, appPaths, draftPaths } from './workspace/home.js'
import { isPairingWindowOpenCached } from './workspace/pairing-window.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the synthetic SDK cwd for a scope. Hands the SDK a deterministic,
 * home-rooted bucket path so `~/.claude/projects/<encoded-cwd>/` lands
 * under our control and never mixes with the user's own `claude` CLI files.
 * Caller must `mkdirSync` before passing to the adapter.
 */
function syntheticCwdFor(scope: string, home: string): string {
  if (scope === 'home') return homeLayout(home).homeAppCwd
  const appId = scopeToAppId(scope) ?? scope
  return appPaths(home, appId).cwd
}

/** Convert a DB Message row into the wire-level entry init shape consumed by
 * `msgChatWindow`. */
function toWindowEntry(row: Message): ChatWindowEntryInit {
  let toolCalls: unknown = null
  if (row.toolCallsJson) {
    try {
      toolCalls = JSON.parse(row.toolCallsJson)
    } catch {
      toolCalls = null
    }
  }
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as ChatWindowEntryInit['role'],
    text: row.text,
    turnMode: row.turnMode,
    source: row.source,
    toolCalls,
    ...(row.clientMsgId ? { clientMsgId: row.clientMsgId } : {}),
    status: row.status,
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.originDeviceId ? { originDeviceId: row.originDeviceId } : {}),
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

async function createAdapter(config: ServerConfig): Promise<LLMAdapter> {
  if (config.backend === 'pi') {
    // Dynamic-import so Pi (and its ~400-package transitive tree) only
    // loads when actually selected. Server boot stays cheap on the Claude
    // path.
    const { PiAgentAdapter } = await import('./agent/pi/adapter.js')
    const adapter = new PiAgentAdapter()
    await adapter.connect({
      type: 'pi',
      home: config.home,
      ...(config.piProvider ? { piProvider: config.piProvider } : {}),
      ...(config.piModel ? { piModel: config.piModel } : {}),
      ...(config.piThinkingLevel ? { piThinkingLevel: config.piThinkingLevel } : {}),
      // Pick the provider-appropriate key. AuthStorage falls back to
      // env vars if neither is set, so OAuth-only users (auth.json) work
      // without setting these.
      ...(config.piProvider === 'anthropic' && config.anthropicApiKey
        ? { apiKey: config.anthropicApiKey }
        : {}),
      ...(config.piProvider === 'openai' && config.openaiApiKey
        ? { apiKey: config.openaiApiKey }
        : {}),
    })
    return adapter
  }

  const adapter = new ClaudeAgentAdapter()
  await adapter.connect({
    type: 'claude',
    apiKey: config.anthropicApiKey,
  })
  return adapter
}

async function createOpenAIAudioService(config: ServerConfig): Promise<AudioService> {
  const { OpenAIAudioService } = await import('./voice/openai-audio.js')
  return new OpenAIAudioService({
    apiKey: config.openaiApiKey!,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
  })
}

// ---------------------------------------------------------------------------
// Server factory (exported for testing)
// ---------------------------------------------------------------------------

export interface ServerComponents {
  httpServer: ReturnType<typeof createServer>
  wsServer: WsServer
  appEngine: AppEngine
  store: ConversationStore
  turnQueue: TurnQueue
  platformDb: ReturnType<typeof openPlatformDb>
  voiceRelay: VoiceRelay
  adapter: LLMAdapter
  config: ServerConfig
  home: string
  fileWatcher?: AppFileWatcher
  scheduler: RefreshScheduler
  /** Draft editing surface — only constructed when dev mode is enabled. */
  draftStore?: DraftStore
  draftRegistry?: DraftRegistry
}

export interface CreateAppServerOpts extends Partial<ServerConfig> {
  /**
   * Inject a pre-built LLMAdapter instead of constructing one from config.
   * Used by integration tests that want a deterministic stand-in (e.g.,
   * `MockAgentAdapter`) without exposing it as a runtime backend choice.
   */
  adapterOverride?: LLMAdapter
}

export async function createAppServer(
  configOverride?: CreateAppServerOpts,
): Promise<ServerComponents> {
  // If a test passes `home` as an override, route it through loadConfig() so
  // home-derived defaults (appDirs, etc.) are computed against the OVERRIDE,
  // not whatever loadConfig() would have resolved on its own.
  const baseConfig = configOverride?.home ? loadConfig({ home: configOverride.home }) : loadConfig()
  const { adapterOverride, ...configRest } = configOverride ?? {}
  const config = { ...baseConfig, ...configRest }

  // 0. Persistence.
  const { home } = config
  fs.mkdirSync(homeLayout(home).homeAppCwd, { recursive: true })
  const platformDb = openPlatformDb(home)
  const store = new ConversationStore(platformDb)
  const faceParamsStore = new FaceParamsStore(platformDb)
  const dedupStore = new DedupStore(platformDb)
  // Background sweep for stale dedup rows; cleared at server close.
  startDedupSweep(dedupStore)

  // Crash recovery: pending/running rows from a prior instance get flipped to
  // failed:server_interrupted with a synthetic assistant row.
  const { recovered } = store.recoverOrphans()
  if (recovered > 0) {
    console.log(`[startup] recovered ${recovered} orphan turn(s) from prior instance`)
  }

  // 1. Transport
  const wsServer = new WsServer({ devModeEnabled: config.devModeEnabled })
  const turnQueue = new TurnQueue()

  // 2. HTTP server. Asset route takes precedence over the health JSON.
  // Health body is cached and refreshed only when the app set changes.
  let healthBody = '{"status":"ok","version":"1","backend":"' + config.backend + '","apps":[]}'
  const refreshHealthBody = (): void => {
    healthBody = JSON.stringify({
      status: 'ok',
      version: '1',
      backend: config.backend,
      apps: appEngine.listApps().map((a) => a.id),
    })
  }
  const httpServer = createServer(async (req, res) => {
    if (await tryServeAssetRequest({ home, url: req.url ?? '', res })) return
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(healthBody)
  })

  // 3. LLM adapter — injected override (tests) or constructed from config
  const adapter = adapterOverride ?? (await createAdapter(config))

  // 4. Audio service + Voice Relay.
  const audioService: AudioService = config.openaiApiKey
    ? await createOpenAIAudioService(config)
    : new MockAudioService()
  console.log(
    `  Audio:   ${config.openaiApiKey ? `OpenAI (stt=${config.sttModel ?? 'gpt-4o-mini-transcribe'}, tts=${config.ttsModel ?? 'gpt-4o-mini-tts'})` : 'mock (set OPENAI_API_KEY to enable)'}`,
  )
  const voiceRelay = new VoiceRelay(audioService, {
    clientStore: wsServer,
    send: (sessionId, message) => wsServer.send(sessionId, message),
  })

  // 5. App Engine — file-backed DBs under <home>/apps/<id>/db.sqlite
  const appEngine = new AppEngine({ home, store, turnQueue })
  appEngine.register(createHomeDef())

  const { loaded, errors: loadErrors } = await loadApps(config.appDirs, process.cwd())
  for (const err of loadErrors) {
    console.error(`[app-loader] Failed: ${err.path}:`, err.error)
  }
  appEngine.registerAll(loaded)
  refreshHealthBody()

  // Build a stable appId → appDir map so every boot (initial, lazy, post-evict)
  // can set app.appDir and run supplemental-scan / dynamic-tool wiring.
  const pluginAppDirs = new Map<string, string>()
  const entryPaths = discoverApps(config.appDirs, process.cwd())
  for (const entryPath of entryPaths) {
    const appDir = resolvePath(entryPath, '..')
    const appName = appDir.split(/[\\/]/).pop()!
    pluginAppDirs.set(appName, appDir)
  }

  // 6. Face update broadcaster. Scope-gated; backpressure-paused sockets skip.
  const sendFaceUpdate: SendFaceUpdate = (appId, faceId, registry, data) => {
    const scope = appId === 'home' ? 'home' : `app:${appId}`
    for (const c of wsServer.getLiveConnections()) {
      if (wsServer.getActiveScope(c.sessionId) !== scope) continue
      if (wsServer.isBackpressurePaused(c.sessionId)) continue
      const selected = registry.selectForSize(faceId, c.sizeClass)
      const components = filterComponentsForDevice(selected.components, c.deviceClass)
      wsServer.send(
        c.sessionId,
        msgFaceUpdate({
          scope,
          appId,
          faceId,
          components,
          data,
        }),
      )
    }
  }

  // Faces currently mounted in this app's scope. Callers skip unmounted faces.
  const mountedFaceIdsFor = (appId: string): ReadonlySet<string> => {
    const scope = appId === 'home' ? 'home' : `app:${appId}`
    const out = new Set<string>()
    for (const m of wsServer.getMountedSet()) {
      if (m.scope === scope) out.add(m.faceId)
    }
    return out
  }

  // 6a. Draft editing (dev mode only).
  let draftRegistry: DraftRegistry | undefined
  let draftStore: DraftStore | undefined
  let runDevTurn: ((sessionId: string, msg: ChatInput) => Promise<void>) | undefined

  if (config.devModeEnabled) {
    const devInflight = new Map<string, AbortController>() // draftId -> in-flight edit turn

    const registry = new DraftRegistry({
      home,
      faceParamsStore,
      transport: wsServer,
      getOptedInSessionCount: (draftId) => wsServer.sessionsPreviewingDraft(draftId).length,
    })
    draftRegistry = registry

    const drafts = new DraftStore({
      home,
      draftRegistry: registry,
      conversationStore: store,
      appEngine,
      skillsRepoDir: resolvePath(process.cwd(), '..', '.claude', 'skills'),
      recordPromotion: (p) => {
        platformDb
          .insert(promotions)
          .values({
            draftId: p.draftId,
            appId: p.appId,
            promotedAt: p.promotedAt,
            summary: p.summary,
            msgCount: p.msgCount,
          })
          .run()
      },
    })
    draftStore = drafts

    // DraftStateChanged goes only to PHONE sessions. `previewable` is
    // recomputed live from the registry so Promote works after a refresh
    // without the agent re-asserting readyForReview.
    const toDraftSummaryInit = (meta: DraftMeta) => ({
      draftId: meta.draftId,
      appId: meta.appId,
      kind: meta.kind,
      createdAtMs: meta.createdAt,
      messageCount: meta.msgCount,
      readyForReview: meta.readyForReview,
      summary: meta.summary,
      previewable: !!registry.get(meta.draftId)?.booted,
    })

    const broadcastDraftState = (
      meta: DraftMeta,
      status: DraftStatus,
      errorMessage?: string,
    ): void => {
      const msg = msgDraftStateChanged({
        draft: toDraftSummaryInit(meta),
        status,
        errorMessage,
      })
      for (const c of wsServer.getLiveConnections()) {
        if (c.deviceClass === DeviceClass.PHONE) wsServer.send(c.sessionId, msg)
      }
    }

    const broadcastDraftRefresh = (appId: string): void => {
      const clients = wsServer.getLiveConnections()
      broadcastAppList(wsServer, appEngine, clients, registry)
      broadcastFaces(wsServer, appEngine, appId, clients, undefined, registry)
    }

    // Boot scan: register + boot drafts with an entry file; remove orphan dirs.
    fs.mkdirSync(homeLayout(home).appsDraftsDir, { recursive: true })
    for (const meta of drafts.listActiveDrafts()) {
      try {
        const dp = draftPaths(home, meta.draftId)
        if (findEntryFile(dp.dir)) {
          const appDef = await reloadSingleApp(dp.dir)
          registry.register(meta.draftId, appDef, {
            appId: meta.appId,
            kind: meta.kind,
            draftDir: dp.dir,
          })
          await registry.boot(meta.draftId)
        }
      } catch (err) {
        console.error(
          `[drafts] boot scan failed for ${meta.draftId}:`,
          err instanceof Error ? err.message : err,
        )
        // Drop partial registration (boot threw) so a half-booted entry
        // can't be accessed. Worktree stays; user can [Reload preview] to retry.
        registry.unregister(meta.draftId)
      }
    }
    for (const name of fs.readdirSync(homeLayout(home).appsDraftsDir)) {
      if (!drafts.getDraft(name)) {
        try {
          fs.rmSync(draftPaths(home, name).dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }

    // Route a dev-chat message to the edit-agent.
    runDevTurn = async (sessionId, msg) => {
      const scope = msg.scope ?? 'home'
      const kind: 'edit' | 'new-app' = scope === 'home' ? 'new-app' : 'edit'
      const liveAppId = kind === 'edit' ? (scopeToAppId(scope) ?? '') : undefined
      console.log(`[dev-turn] recv scope=${scope} kind=${kind}`)

      let meta =
        kind === 'edit'
          ? drafts.getDraftByApp(liveAppId!)
          : drafts.listActiveDrafts().find((m) => m.kind === 'new-app')
      let conversationId: string
      if (!meta) {
        try {
          const created =
            kind === 'edit'
              ? await drafts.createDraft({ kind: 'edit', appId: liveAppId! })
              : await drafts.createDraft({ kind: 'new-app' })
          meta = created.meta
          conversationId = created.conversationId
          wsServer.setPreviewingDraft(sessionId, meta.draftId, true) // auto opt-in initiator
          broadcastDraftState(meta, DraftStatus.CREATED)
          console.log(`[dev-turn] draft created draft=${meta.draftId} scope=${scope}`)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          // Loud: draft materialization (worktree copy / shadow-DB clone /
          // reloadSingleApp / boot) failed. Send both a DraftActionResult (for
          // MCP callers) and a kind=DEV chat row — a DraftActionResult alone
          // isn't consumed by the PWA's send path, which would leave the dev
          // tab stuck on "thinking" with nothing in the log.
          console.error(`[dev-turn] createDraft failed scope=${scope} kind=${kind}:`, detail)
          wsServer.send(
            sessionId,
            msgDraftActionResult({ draftId: 'unknown', ok: false, error: detail }),
          )
          // Also push a kind=DEV assistant row so the PWA clears its pending
          // dots and shows the failure (cleared on any kind=DEV chat message).
          wsServer.send(
            sessionId,
            msgChat({
              id: `dev-err-${Date.now()}`,
              scope,
              conversationId: '',
              role: 'assistant',
              text: `Couldn't start the edit draft: ${detail}`,
              timestamp: new Date().toISOString(),
              kind: 'dev',
            }),
          )
          return
        }
      } else {
        conversationId =
          store.findDevConversationByDraft(meta.draftId)?.id ??
          store.getActive(scope, 'dev', meta.draftId).id
      }
      if (!meta) return // unreachable; satisfies narrowing

      const draftId = meta.draftId
      // Serialize dev turns per draft: concurrent turns would race on session
      // binding. Reject while one is in flight.
      if (devInflight.has(draftId)) {
        store.appendTurn(conversationId, {
          role: 'assistant',
          text: 'An edit is already in progress — please wait for it to finish before sending another message.',
          turnMode: 'direct_user_chat',
        })
        return
      }
      drafts.markDirty(draftId)
      drafts.incrementMsgCount(draftId)
      const m0 = drafts.getDraft(draftId)
      if (m0) broadcastDraftState(m0, DraftStatus.UPDATED)

      store.appendTurn(conversationId, {
        role: 'user',
        text: msg.text,
        turnMode: 'direct_user_chat',
        // Echo clientMsgId so the PWA reconciles its optimistic dev bubble.
        ...(msg.clientMsgId ? { clientMsgId: msg.clientMsgId } : {}),
      })

      const dp = draftPaths(home, draftId)
      const conv = store.getById(conversationId)
      // Edit turns are single-flight per draft (guarded above), so the read
      // need not be in a queue slot; sdkResumeArgs keeps the rule in one place.
      const resume = sdkResumeArgs(
        conv ?? { sdkSessionId: null, sdkBoundAt: null, sdkBackend: null },
        config.backend,
      )
      const ac = new AbortController()
      devInflight.set(draftId, ac)
      const t0 = Date.now()
      console.log(
        `[dev-turn] start draft=${draftId} conv=${conversationId.slice(0, 8)} kind=${kind} chars=${msg.text.length}`,
      )

      const editReq = buildEditAgentRequest({
        draftId,
        conversationId,
        message: msg.text,
        kind,
        draftDir: dp.dir,
        appsSrcDir: homeLayout(home).appsSrcDir,
        shadowDbPath: dp.shadowDbFile,
        ...(liveAppId ? { liveAppId } : {}),
        // validate_types needs the home (scratch tsconfig) + repo root (apps/tsconfig.json
        // + tsconfig.base.json). repoRoot = parent of cwd, matching skillsRepoDir above.
        home,
        repoRoot: resolvePath(process.cwd(), '..'),
        sdkBound: resume.sdkBound,
        ...(resume.sdkSessionId ? { sdkSessionId: resume.sdkSessionId } : {}),
        signal: ac.signal,
        markReadyForReview: (summary) => {
          drafts.markReadyForReview(draftId, summary)
          const m = drafts.getDraft(draftId)
          if (m) broadcastDraftState(m, DraftStatus.UPDATED)
        },
      })

      // AgentLoop is reused but toolCall events don't fire for the edit-agent.
      // The registries/db below are placeholders for that dormant path.
      const draftApp = registry.get(draftId)?.booted
      // New-app draft not yet booted on first turn — fall back to home's db.
      const placeholderDb = draftApp?.db ?? appEngine.getApp('home')?.db
      if (!placeholderDb) {
        devInflight.delete(draftId)
        store.appendTurn(conversationId, {
          role: 'assistant',
          text: 'Internal error: no database handle available for the edit-agent.',
          turnMode: 'direct_user_chat',
        })
        return
      }
      const agentLoop = new AgentLoop({
        adapter,
        toolRegistry: draftApp?.toolRegistry ?? new Map(),
        faceRegistry: draftApp?.faceRegistry ?? new FaceRegistry(),
        db: placeholderDb,
        appId: liveAppId ?? draftId,
        sendFaceUpdate,
        faceParamsStore,
        context: {},
        config: {},
        // Mid-turn TodoWrite checklist → progress card. Same PHONE + active-scope
        // filter as the dev append bus, so todos never reach ESP32/Wear.
        onTodos: (todos) => {
          const todosMsg = msgChatTodosUpdate({ scope, conversationId, todos })
          for (const c of wsServer.getLiveConnections()) {
            if (
              c.deviceClass === DeviceClass.PHONE &&
              wsServer.getActiveScope(c.sessionId) === scope
            ) {
              wsServer.send(c.sessionId, todosMsg)
            }
          }
        },
      })

      try {
        const result = await agentLoop.runTurn(editReq)
        if (result.sdkSessionId)
          store.bindSdkSession(conversationId, result.sdkSessionId, config.backend)
        const text = result.success ? result.text : result.text || '(edit-agent turn failed)'
        // Persist the assistant reply; the store 'append' bus broadcasts it to
        // PWA dev tabs with kind='dev' (the dev conversation is kind='dev').
        store.appendTurn(conversationId, { role: 'assistant', text, turnMode: 'direct_user_chat' })
        if (ac.signal.aborted) {
          console.log(`[dev-turn] aborted draft=${draftId} durationMs=${Date.now() - t0}`)
        } else {
          console.log(
            `[dev-turn] done draft=${draftId} ok=${result.success} durationMs=${Date.now() - t0} toolCalls=${result.toolCalls.length}`,
          )
          // Auto-reload so preview reflects the agent's edits. The hot-reload
          // file watcher doesn't watch draft worktrees; explicit [Reload preview]
          // is the only other reload path. Load failures surface as draft state.
          const reload = await drafts.reloadDraft(draftId)
          const m = drafts.getDraft(draftId)
          if (m) {
            if (reload.ok) {
              broadcastDraftState(m, DraftStatus.UPDATED)
              broadcastDraftRefresh(m.appId)
              console.log(`[dev-turn] reloaded preview draft=${draftId} appId=${m.appId}`)
            } else {
              broadcastDraftState(m, DraftStatus.FAILED, reload.error)
              console.warn(`[dev-turn] preview reload failed draft=${draftId}: ${reload.error}`)
            }
          }
        }
      } catch (err) {
        console.error(
          `[dev-turn] failed draft=${draftId} durationMs=${Date.now() - t0}`,
          err instanceof Error ? err.message : err,
        )
        // Append an error row so the PWA dev tab clears its "thinking" indicator.
        // Skip on abort (conversation may have been archived by discard).
        if (!ac.signal.aborted) {
          try {
            store.appendTurn(conversationId, {
              role: 'assistant',
              text: `The edit-agent turn failed: ${err instanceof Error ? err.message : String(err)}`,
              turnMode: 'direct_user_chat',
            })
          } catch {
            /* conversation may have been archived mid-turn */
          }
        }
      } finally {
        devInflight.delete(draftId)
      }
    }

    // ---- Draft action handlers (each ACKs via DraftActionResult) ----
    wsServer.onPreviewOptIn((sessionId, m) => {
      const ok = wsServer.setPreviewingDraft(sessionId, m.draftId, m.optIn)
      wsServer.send(sessionId, msgDraftActionResult({ draftId: m.draftId, ok }))
      if (ok) {
        const meta = drafts.getDraft(m.draftId)
        const clients = wsServer.getLiveConnections()
        broadcastAppList(wsServer, appEngine, clients, registry)
        if (meta) broadcastFaces(wsServer, appEngine, meta.appId, clients, undefined, registry)
      }
    })

    wsServer.onDraftReload(async (sessionId, m) => {
      const res = await drafts.reloadDraft(m.draftId)
      wsServer.send(
        sessionId,
        msgDraftActionResult({
          draftId: m.draftId,
          ok: res.ok,
          error: res.ok ? undefined : res.error,
        }),
      )
      const meta = drafts.getDraft(m.draftId)
      if (!meta) return
      if (res.ok) {
        broadcastDraftState(meta, DraftStatus.UPDATED)
        broadcastDraftRefresh(meta.appId)
      } else {
        broadcastDraftState(meta, DraftStatus.FAILED, res.error)
      }
    })

    wsServer.onDraftPromote(async (sessionId, m) => {
      const meta = drafts.getDraft(m.draftId)
      const res = await drafts.promoteDraft(m.draftId)
      wsServer.send(
        sessionId,
        msgDraftActionResult({
          draftId: m.draftId,
          ok: res.ok,
          error: res.ok ? undefined : res.error,
        }),
      )
      if (!meta) return
      if (res.ok) {
        broadcastDraftState(meta, DraftStatus.PROMOTED)
        broadcastDraftRefresh(meta.appId)
      } else {
        broadcastDraftState(meta, DraftStatus.FAILED, res.error)
      }
    })

    wsServer.onDraftDiscard((sessionId, m) => {
      const meta = drafts.getDraft(m.draftId)
      devInflight.get(m.draftId)?.abort()
      const res = drafts.discardDraft(m.draftId)
      wsServer.send(
        sessionId,
        msgDraftActionResult({
          draftId: m.draftId,
          ok: res.ok,
          error: res.ok ? undefined : res.error,
        }),
      )
      if (res.ok && meta) {
        broadcastDraftState(meta, DraftStatus.DISCARDED)
        broadcastDraftRefresh(meta.appId)
      }
    })

    wsServer.onDraftTurnCancel((sessionId, m) => {
      devInflight.get(m.draftId)?.abort()
      wsServer.send(sessionId, msgDraftActionResult({ draftId: m.draftId, ok: true }))
    })

    // Reset the dev conversation (archive + fresh row) while keeping the
    // draft/worktree. A new-app draft's dev scope is 'home', so kind (not
    // scope) is the discriminator. The chat reset handler skips kind=DEV.
    wsServer.onResetConversation((_sessionId, msg) => {
      if (msg.kind !== ChatKind.DEV) return
      const scope = msg.scope || 'home'
      const meta =
        scope === 'home'
          ? drafts.listActiveDrafts().find((m) => m.kind === 'new-app')
          : drafts.getDraftByApp(scopeToAppId(scope) ?? '')
      if (!meta) return // no active draft → nothing to reset (defensive)
      const conv = store.findDevConversationByDraft(meta.draftId)
      if (!conv) return // draft has no dev thread yet → nothing to reset
      // Abort in-flight turn before archiving (dev turn ignores the archived-append on abort).
      devInflight.get(meta.draftId)?.abort()
      // Archive + fresh dev conversation (fresh row keeps draftId so routing
      // + reconnect replay still resolve it). Emits reset event (kind='dev').
      store.reset(scope, 'dev', meta.draftId)
      // Thread is now empty — update count, but leave the draft/worktree intact.
      drafts.resetMsgCount(meta.draftId)
      const m = drafts.getDraft(meta.draftId)
      if (m) broadcastDraftState(m, DraftStatus.UPDATED)
      console.log(`[dev-reset] scope=${scope} draft=${meta.draftId}`)
    })

    // On (re)connect, replay existing drafts to PHONE clients so they rebuild
    // their drafts map and re-opt-in to preview.
    wsServer.onConnect((sessionId, _deviceId, deviceClass) => {
      if (deviceClass !== DeviceClass.PHONE) return
      for (const meta of drafts.listActiveDrafts()) {
        wsServer.send(
          sessionId,
          msgDraftStateChanged({
            draft: toDraftSummaryInit(meta),
            status: DraftStatus.CREATED,
          }),
        )
        // Replay the dev-conversation window. `sendInitialState` only sends the
        // kind='chat' window; without this the dev thread comes back empty.
        const devScope = meta.kind === 'new-app' ? 'home' : `app:${meta.appId}`
        if (store.findDevConversationByDraft(meta.draftId)) {
          const w = store.getWindow(devScope, 50, 'dev')
          wsServer.send(
            sessionId,
            msgChatWindow({
              scope: devScope,
              conversationId: w.conversationId,
              entries: w.entries.map(toWindowEntry),
              kind: 'dev',
            }),
          )
        }
      }
    })
  }

  // 6b. Refresh scheduler. `onTaskComplete` triggers a face refresh so
  // mounted clients see the new DB rows.
  const scheduler = new RefreshScheduler({
    getMountedSet: () => wsServer.getMountedSet(),
    onTaskComplete: (appId) => {
      const app = appEngine.getApp(appId)
      if (!app) return
      try {
        // Load persisted view-state so parameterized faces keep their params
        // on post-task broadcast (avoids clobbering with empty params).
        const scope = appId === 'home' ? 'home' : `app:${appId}`
        const conv = store.getActive(scope)
        const paramsByFaceId = faceParamsStore.validateAndLoad(conv.id, appId, app.faceRegistry)
        // Cap to mounted faces only — avoids resolving faces no client is viewing.
        const mountedFaceIds = mountedFaceIdsFor(appId)
        refreshAllFaces(
          appId,
          app.faceRegistry,
          {
            db: app.db,
            paramsByFaceId,
            context: app.context,
            staleness: (taskId: string) => scheduler.getStaleness(appId, taskId),
            faceStaleness: (faceId, params) =>
              scheduler.getFaceStalenessOrNull(appId, faceId, params),
          },
          sendFaceUpdate,
          mountedFaceIds,
        )
      } catch (err) {
        console.error('[refresh-scheduler] onTaskComplete refresh failed:', err)
      }
    },
  })

  // 7. Subscribe the store event bus to ws broadcast. The ONLY path for `chat`
  // frames — inline wsServer.send('chat') calls elsewhere are forbidden.
  store.on('append', ({ scope, conversationId, row }) => {
    const entry = toWindowEntry(row)
    // Dev conversations go only to PHONE sessions, never ESP32/Wear.
    const isDev = store.getById(conversationId)?.kind === 'dev'
    const msg = msgChat({
      id: entry.id,
      scope,
      conversationId,
      role: entry.role as 'user' | 'assistant' | 'system',
      text: entry.text,
      timestamp: entry.createdAt,
      ...(entry.clientMsgId ? { clientMsgId: entry.clientMsgId } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
      ...(entry.originDeviceId ? { originDeviceId: entry.originDeviceId } : {}),
      ...(isDev ? { kind: 'dev' as const } : {}),
    })
    if (isDev) {
      for (const c of wsServer.getLiveConnections()) {
        if (c.deviceClass === DeviceClass.PHONE && wsServer.getActiveScope(c.sessionId) === scope) {
          wsServer.send(c.sessionId, msg)
        }
      }
    } else {
      wsServer.broadcastToScope(scope, msg)
    }
  })
  // Turn lifecycle transitions produce incremental `chatUpdate` frames.
  // originDeviceId lets siblings attribute the status change to the initiating device.
  store.on('update', ({ scope, conversationId, row }) => {
    const isDev = store.getById(conversationId)?.kind === 'dev'
    const msg = msgChatUpdate({
      scope,
      conversationId,
      id: row.id,
      status: row.status,
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
      ...(row.originDeviceId ? { originDeviceId: row.originDeviceId } : {}),
      ...(isDev ? { kind: 'dev' as const } : {}),
    })
    if (isDev) {
      for (const c of wsServer.getLiveConnections()) {
        if (c.deviceClass === DeviceClass.PHONE && wsServer.getActiveScope(c.sessionId) === scope) {
          wsServer.send(c.sessionId, msg)
        }
      }
    } else {
      wsServer.broadcastToScope(scope, msg)
    }
  })
  // Scope → sessionId of the most recent `/reset` requester. Stashed just
  // before store.reset() fires so the 'reset' listener below can send siblings
  // a `resetNotice` before the empty `chatWindow`.
  const pendingResetRequesters = new Map<string, string>()
  store.on('reset', ({ scope, newConversationId, kind }) => {
    if (kind === 'dev') {
      // Dev-thread reset: clear ONLY the dev window, routed like the dev-append
      // bus — PHONE sessions viewing this scope. No resetNotice (dev is a
      // single-builder thread) and no escalation clearing (dev turns abort via
      // devInflight in the dev-reset handler, not the LLM-escalation path).
      const emptyDev = msgChatWindow({
        scope,
        conversationId: newConversationId,
        entries: [],
        kind: 'dev',
      })
      for (const c of wsServer.getLiveConnections()) {
        if (c.deviceClass === DeviceClass.PHONE && wsServer.getActiveScope(c.sessionId) === scope) {
          wsServer.send(c.sessionId, emptyDev)
        }
      }
      return
    }
    const requesterSessionId = pendingResetRequesters.get(scope) ?? ''
    pendingResetRequesters.delete(scope)
    // Reset cancels any in-flight escalation for this scope. Reset events
    // carry only the NEW conversationId, so we look up the OLD entry by its
    // stored scope. Aborts the LLM turn and clears the pending flag so the
    // fresh conversation starts unblocked.
    clearPendingEscalationsByScope(scope)
    wsServer.broadcastToScope(
      scope,
      msgResetNotice({
        scope,
        conversationId: newConversationId,
        requesterSessionId,
        timestamp: new Date().toISOString(),
      }),
    )
    wsServer.broadcastToScope(
      scope,
      msgChatWindow({
        scope,
        conversationId: newConversationId,
        entries: [],
      }),
    )
  })

  // 7b. BroadcastTransport: persists focus to the devices table and pushes
  // Navigate to the live device; offline devices pick it up on next reconnect.
  const transport: BroadcastTransport = {
    broadcast: (msg) => wsServer.broadcast(msg),
    send: (sessionId, msg) => wsServer.send(sessionId, msg),
    setDeviceFocus: (deviceId, appId, faceId) => {
      store.setDeviceFocus(deviceId, appId, faceId ?? null)
      const sid = wsServer.getSessionByDeviceId(deviceId)
      if (sid) {
        // Persist face mount so getMountedSet() reports the right (faceId, paramsKey)
        // for face-bound worker dedup. Reconcile immediately so adaptive cadence
        // applies on this tick.
        if (faceId) {
          const scope = appIdToScope(appId)
          const conv = store.getActive(scope)
          const stored = faceParamsStore.get(conv.id, appId, faceId)
          wsServer.setCurrentFaceMount(sid, faceId, stored?.params ?? {})
          scheduler.notifyMountedSetChanged()
        }
        wsServer.send(
          sid,
          msgNavigate({
            appId,
            ...(faceId ? { faceId } : {}),
          }),
        )
      }
    },
  }

  // 8. Wire home tools with runtime deps
  const homeToolDeps = {
    runDelegation: (appId: string, message: string) =>
      runDelegation(appId, message, {
        appEngine,
        adapter,
        store,
        sendFaceUpdate,
        turnQueue,
        backend: config.backend,
        home,
        faceParamsStore,
      }),
    getAppList: () =>
      appEngine
        .listApps()
        .filter((m) => m.id !== 'home')
        .map((m) => ({ appId: m.id, name: m.name, description: m.description })),
    // Navigate targets the originating device only. Undefined = server-internal turn (skip).
    setDeviceFocus: (deviceId: string, appId: string) => {
      transport.setDeviceFocus?.(deviceId, appId)
    },
  }

  // 9a. setContext factory: writes context.json atomically and reloads
  // BootedApp.context in-place so subsequent turns see the new value.
  function makeSetContextFor(appId: string, schema: unknown) {
    return async (field: string, value: unknown): Promise<void> => {
      await setContextField({ home, appId, schema }, field, value)
      const app = appEngine.getApp(appId)
      if (!app) return
      const fresh = loadAppContext({ home, appId, schema })
      app.context = fresh
    }
  }

  // 9. Helper: supplemental scan + re-wire after boot/reboot
  async function rewireApp(appId: string, appDir: string): Promise<void> {
    const app = appEngine.getApp(appId)!

    // Supplemental scan: pick up extra tool/face files (size variants, promoted
    // files). Shared with the draft boot path so preview == live.
    await applySupplementalScan({
      appDir,
      toolRegistry: app.toolRegistry,
      faceRegistry: app.faceRegistry,
      source: `hot-reload:${appId}`,
    })

    // Wire tools
    if (appId === 'home') {
      wireHomeTools(app.toolRegistry, homeToolDeps)
    }

    // Synthesize view_<faceId> tools for every parameterized face on this app.
    // Idempotent — clears prior synth tools, validates collisions, re-registers,
    // and runs sweepStaleVersions to clean stale `face_params` rows from past
    // schema versions.
    wireSynthFaceTools({ appId, appEngine, faceParamsStore, transport })
  }

  // 10. File watcher for hot-reload
  let fileWatcher: AppFileWatcher | undefined
  if (config.hotReload) {
    const reloadingApps = new Set<string>()

    const handleReload = async (appDir: string, action: string) => {
      const appName = appDir.split(/[\\/]/).pop()!
      if (reloadingApps.has(appName)) return
      reloadingApps.add(appName)
      try {
        const appDef = await reloadSingleApp(appDir)
        await appEngine.swapApp(appDef)
        const app = appEngine.getApp(appDef.manifest.id)!
        app.appDir = appDir
        await rewireApp(appDef.manifest.id, appDir)
        broadcastAppList(wsServer, appEngine, wsServer.getLiveConnections(), draftRegistry)
        // Hot-reload broadcasts must carry persisted view-state — without it,
        // parameterized faces drop to emptyState and destroy the user's view.
        const reloadScope = appDef.manifest.id === 'home' ? 'home' : `app:${appDef.manifest.id}`
        const reloadConv = store.getActive(reloadScope)
        const reloadParams = faceParamsStore.validateAndLoad(
          reloadConv.id,
          appDef.manifest.id,
          app.faceRegistry,
        )
        broadcastFaces(
          wsServer,
          appEngine,
          appDef.manifest.id,
          wsServer.getLiveConnections(),
          reloadParams,
          draftRegistry,
        )
        refreshHealthBody()
        console.log(`[hot-reload] ${action}: ${appDef.manifest.id}`)
      } catch (err) {
        console.error(
          `[hot-reload] Failed to ${action.toLowerCase()} ${appDir}:`,
          err instanceof Error ? err.message : err,
        )
      } finally {
        // Clear immediately so a follow-up edit can retry without delay.
        reloadingApps.delete(appName)
      }
    }

    fileWatcher = new AppFileWatcher(
      config.appDirs,
      process.cwd(),
      {
        onAppChanged: (appDir) => handleReload(appDir, 'Reloaded'),
        onAppAdded: (appDir) => handleReload(appDir, 'Added'),
        onAppRemoved: (appDir) => {
          const name = appDirToName(appDir)
          const match = appEngine.listApps().find((a) => a.id === name)
          if (match) {
            appEngine.unregister(match.id)
            broadcastAppList(wsServer, appEngine, wsServer.getLiveConnections(), draftRegistry)
            refreshHealthBody()
            console.log(`[hot-reload] Removed: ${match.id}`)
          }
        },
      },
      config.hotReloadDebounceMs,
    )
    fileWatcher.start()
    console.log(`[hot-reload] Watching ${config.appDirs.join(', ')}`)
  }

  // 11. afterBootHook: runs rewireApp for every app boot (initial, lazy,
  // post-evict). Home has no on-disk appDir; plugin apps use the discovery map.
  appEngine.setAfterBootHook(async (appId: string) => {
    const app = appEngine.getApp(appId)
    if (!app) return
    const appDef = appEngine.getDefinition(appId)

    // Build per-app HttpClient + AssetCache (fresh on hot-reload so breaker /
    // budget state reflects any upstream config change).
    const upstream = appDef?.upstream
    const httpClient = createHttpClient({
      appId,
      ...(upstream?.maxRequestsPerMinute
        ? { maxRequestsPerMinute: upstream.maxRequestsPerMinute }
        : {}),
    })
    const assetCache = createAssetCache({ appId, home, http: httpClient })
    app.httpClient = httpClient
    app.assetCache = assetCache

    const appDir = pluginAppDirs.get(appId)
    if (appDir) {
      app.appDir = appDir
      await rewireApp(appId, appDir)
    } else if (appId === 'home') {
      // Home has no external appDir; still needs wireHomeTools.
      wireHomeTools(app.toolRegistry, homeToolDeps)
      // Synth view tools (no-op for home today; keeps wiring symmetric).
      wireSynthFaceTools({ appId: 'home', appEngine, faceParamsStore, transport })
    }

    // Register refresh tasks. swapApp re-fires this hook; unregisterApp
    // inside registerApp stops prior-generation tasks first.
    if (appDef) {
      const setContextFor = makeSetContextFor(appId, appDef.context)

      // Synthesize `update_context` for apps with a non-empty context schema.
      // Returns null when there are no fields to write.
      const updateContextTool = synthesizeUpdateContextTool({
        appId,
        contextSchema: appDef.context,
        setContext: setContextFor,
      })
      if (updateContextTool) {
        app.toolRegistry.set(updateContextTool.name, updateContextTool)
      }

      const buildAppCtx = (): Omit<RefreshContext, 'params'> => ({
        db: app.db,
        http: httpClient,
        cacheAsset: assetCache,
        config: app.config,
        context: app.context,
        setContext: setContextFor,
      })

      scheduler.registerApp({
        appId,
        tasks: appDef.refreshTasks ?? [],
        contextFactory: buildAppCtx,
      })

      for (const face of appDef.faces) {
        if (!face.refresh) continue
        scheduler.registerFace({
          appId,
          faceId: face.id,
          refresh: face.refresh,
          contextFactory: (params) => ({ ...buildAppCtx(), params }),
        })
      }

      // Boot warmup runs every task with `warmup: true` once. Logged as
      // best-effort — a warmup failure shouldn't block subsequent ticks.
      scheduler.warmup(appId).catch((err) => {
        console.error(`[refresh-scheduler] warmup failed for "${appId}":`, err)
      })
    }
  })

  // Pre-evict: stop scheduler tasks before the DB handle closes to prevent
  // in-flight tick vs. close() races. Applies to swapApp / unregister / shutdown.
  appEngine.setBeforeEvictHook((appId: string) => {
    scheduler.unregisterApp(appId)
  })

  // Eager-boot home so the launcher face is ready on first connect.
  // Plugin apps lazy-boot on first use().
  await appEngine.use('home').catch((err) => {
    console.error('[app-engine] failed to eager-boot home:', err)
  })
  appEngine.startSweeper()
  // Start scheduler. Plugin tasks register on first use(); start() is idempotent.
  scheduler.start()

  // Daily maintenance: purge old archived conversations + VACUUM (skips when busy).
  // unref'd so the timer doesn't hold the event loop alive past shutdown.
  const isServerBusy = (): boolean => {
    for (const a of appEngine.listApps()) {
      for (const cid of store.activeConversationIdsForApp(a.id)) {
        if (turnQueue.hasPending(cid)) return true
      }
    }
    return false
  }
  const runMaintenance = (): void => {
    try {
      if (config.archivedConversationsDays > 0) {
        const r = store.purgeArchivedOlderThan(config.archivedConversationsDays)
        if (r.conversationsDeleted > 0 || r.messagesDeleted > 0) {
          console.log(
            JSON.stringify({
              event: 'maintenance_purge',
              ...r,
              olderThanDays: config.archivedConversationsDays,
            }),
          )
        }
      }
      vacuumIfIdle(platformDb, { isBusy: isServerBusy, log: (e) => console.log(JSON.stringify(e)) })
    } catch (err) {
      console.error('[maintenance] sweep failed:', err instanceof Error ? err.message : err)
    }
  }
  const maintenanceTimer = setInterval(runMaintenance, 24 * 60 * 60 * 1000)
  maintenanceTimer.unref?.()

  // -------------------------------------------------------------------------
  // WS callbacks
  // -------------------------------------------------------------------------

  // Per-session neighbor-prefetch timers. A swipe schedules a 150 ms timer;
  // another `viewing` before it fires cancels and reschedules it. Cleared on disconnect.
  const pendingPrefetchTimers = new Map<string, NodeJS.Timeout>()
  const NEIGHBOR_PREFETCH_DELAY_MS = 150

  /**
   * Push faceList + faceUpdate for `appId` to one client. Shared between
   * initial-connect state sync and every `viewing` scope change.
   */
  const pushAppFaces = (sessionId: string, appId: string) => {
    const client = wsServer.getLiveConnections().find((c) => c.sessionId === sessionId)
    const sc = client?.sizeClass ?? SizeClass.EXPANDED
    // Draft-aware: sessions previewing a draft see the draft's booted app.
    // For new-app drafts this is the ONLY booted app (no live counterpart).
    const previewed = draftRegistry
      ?.listActiveDrafts()
      .find((d) => d.appId === appId && d.booted && client?.previewingDraft?.has(d.draftId))
    const app = previewed?.booted ?? appEngine.getApp(appId)
    if (!app) return
    const variant = previewed ? AppVariant.DRAFT : undefined
    const scope = appId === 'home' ? 'home' : `app:${appId}`
    const faces = app.faceRegistry.list()
    wsServer.send(
      sessionId,
      msgFaceList({
        appId,
        faces: faces.map((f) => ({ faceId: f.id, label: f.label, position: f.position })),
      }),
    )

    // Load persisted view-state so parameterized faces render with their stored
    // params. Draft view-state is keyed by draftId.
    const paramsKey = previewed ? previewed.draftId : store.getActive(scope).id
    const paramsByFaceId = faceParamsStore.validateAndLoad(paramsKey, appId, app.faceRegistry)

    // Apply DeviceClass-aware component filtering on this path too. The
    // refresh-tick path (agent/broadcast.ts:105) already does this; without
    // it here, initial-viewing pushes include component types the client
    // can't render — they appear once on the first push and then disappear
    // on the next refresh-driven faceUpdate, leaving parent containers with
    // dangling child ID references (e.g. a Row referencing chips that the
    // refresh path strips). Filtering both paths makes the catalog the
    // single source of truth for what each device class receives.
    const deviceClass = client?.deviceClass ?? DeviceClass.PHONE
    for (const face of faces) {
      const selected = app.faceRegistry.selectForSize(face.id, sc)
      const data = app.faceRegistry.resolveOne(face.id, {
        db: app.db,
        paramsByFaceId,
        context: app.context,
        staleness: (taskId: string) => scheduler.getStaleness(appId, taskId),
        faceStaleness: (faceId, params) => scheduler.getFaceStalenessOrNull(appId, faceId, params),
      })
      const components = filterComponentsForDevice(selected.components, deviceClass)
      wsServer.send(
        sessionId,
        msgFaceUpdate({
          scope,
          appId,
          faceId: face.id,
          components,
          data,
          variant,
        }),
      )
    }

    // Seed currentFaceId to position-0 so the scheduler's mountedOnly gate fires.
    // Per-face accuracy is set via the navigate path.
    const firstFace = faces[0]
    if (firstFace && wsServer.getActiveScope(sessionId) === scope) {
      wsServer.setCurrentFaceMount(sessionId, firstFace.id, paramsByFaceId[firstFace.id] ?? {})
      scheduler.notifyMountedSetChanged()
    }
  }

  /**
   * Lazy-boot (if needed) and push faces for one neighbor app. No chatWindow,
   * no setDeviceFocus — neighbors are warm-only cache fill, not subscribed.
   * `pushAppFaces` itself already gates `setCurrentFaceMount` to active-scope
   * sessions, so refresh-scheduler mounting isn't triggered for neighbors.
   */
  const pushNeighborFaces = (sessionId: string, appId: string) => {
    const already = appEngine.getApp(appId)
    if (already) {
      pushAppFaces(sessionId, appId)
      return
    }
    void appEngine
      .use(appId)
      .then(() => {
        pushAppFaces(sessionId, appId)
      })
      .catch((err) => {
        console.warn(
          `[main] neighbor prefetch lazy-boot failed for ${appId}:`,
          err instanceof Error ? err.message : err,
        )
      })
  }

  /**
   * Left + right neighbors of `appId` in the canonical app order. Either side
   * is `undefined` when out of bounds (first/last app).
   */
  const neighborsOf = (appId: string): { left?: string; right?: string } => {
    const list = appEngine.listApps()
    const idx = list.findIndex((a) => a.id === appId)
    if (idx < 0) return {}
    const left = idx > 0 ? list[idx - 1]?.id : undefined
    const right = idx < list.length - 1 ? list[idx + 1]?.id : undefined
    return {
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
    }
  }

  /**
   * (Re-)schedule the debounced neighbor prefetch for `sessionId`. Replaces
   * any existing pending timer so the latest active wins. `excludeIds`
   * names apps that were already pushed eagerly in the same scope-change —
   * skipped so we don't redundantly re-resolve them (e.g. `home` on initial
   * connect when activeAppId is its immediate right neighbour).
   */
  const scheduleNeighborPrefetch = (
    sessionId: string,
    activeAppId: string,
    excludeIds: ReadonlySet<string> = new Set(),
  ) => {
    const existing = pendingPrefetchTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingPrefetchTimers.delete(sessionId)
      const { left, right } = neighborsOf(activeAppId)
      if (left && !excludeIds.has(left)) pushNeighborFaces(sessionId, left)
      if (right && !excludeIds.has(right)) pushNeighborFaces(sessionId, right)
    }, NEIGHBOR_PREFETCH_DELAY_MS)
    pendingPrefetchTimers.set(sessionId, timer)
  }

  /**
   * Push initial app + face state to one client. Also seeds `activeScope` to
   * whatever the client declared via hello nav-intent so the first `chat`
   * broadcast finds a non-undefined scope.
   */
  const sendInitialState = (sessionId: string, deviceId: string, nav?: HelloNavIntent) => {
    // Server-SSOT: read persisted active scope. Falls back to ClientHello
    // nav-intent for first-connect devices, then 'home' as ultimate default.
    const device = store.getDevice(deviceId)
    const persistedAppId = device?.lastActiveApp
    const navAppId = nav?.currentAppId
    const activeAppId =
      persistedAppId || (navAppId && navAppId.length > 0 ? navAppId : null) || 'home'
    const activeScope = activeAppId === 'home' ? 'home' : `app:${activeAppId}`

    if (wsServer.getActiveScope(sessionId) === undefined) {
      wsServer.setActiveScope(sessionId, activeScope)
    }

    // Use shared builder so appList carries `themeSeed` — same as broadcastAppList.
    wsServer.send(sessionId, msgAppList({ apps: liveAppEntries(appEngine) }))

    // Always push home faces — the launcher tile-row needs them regardless of scope.
    pushAppFaces(sessionId, 'home')

    // Push the active app's faces (lazy-booting if dormant). When activeAppId
    // is 'home', skip — already pushed above.
    if (activeAppId !== 'home') {
      const defs = appEngine.listApps()
      if (defs.some((d) => d.id === activeAppId)) {
        const already = appEngine.getApp(activeAppId)
        if (already) {
          pushAppFaces(sessionId, activeAppId)
        } else {
          void appEngine
            .use(activeAppId)
            .then(() => {
              pushAppFaces(sessionId, activeAppId)
            })
            .catch((err) => {
              console.warn(
                `[main] failed to bootstrap ${activeAppId}:`,
                err instanceof Error ? err.message : err,
              )
            })
        }
      }
    }

    // Initial chatWindow for the active scope so the chat overlay has
    // something to show before the user types.
    const window = store.getWindow(activeScope)
    wsServer.send(
      sessionId,
      msgChatWindow({
        scope: activeScope,
        conversationId: window.conversationId,
        entries: window.entries.map(toWindowEntry),
      }),
    )

    // Warm neighbors so the first swipe paints from cache. Uses the same
    // debounce as `onViewing`. Home and the active app were already pushed.
    scheduleNeighborPrefetch(sessionId, activeAppId, new Set(['home', activeAppId]))
  }

  // Seed device row's initial focus from nav-intent. Only applies on first
  // insert; existing rows keep their persisted last_active_app/face.
  const initialFocusFrom = (nav?: HelloNavIntent) => ({
    initialApp: nav?.currentAppId && nav.currentAppId.length > 0 ? nav.currentAppId : 'home',
    ...(nav?.currentFaceId && nav.currentFaceId.length > 0
      ? { initialFace: nav.currentFaceId }
      : {}),
  })

  // Pairing gate — runs before ServerHello. deviceId is the credential;
  // approving flips the paired flag. Unknown devices are recorded so they
  // show up in `task server:cli -- device list`; unrecorded when pairingRequired is off.
  wsServer.setPairingResolver(
    ({ deviceId, clientSuppliedId, deviceClass, deviceProfile, userAgent }) => {
      if (!clientSuppliedId) {
        // No stable id → unpairable. Reject when pairingRequired; never record a row.
        return !config.pairingRequired
      }
      const record = (): void =>
        store.upsertDevice({
          deviceId,
          deviceClass,
          ...(deviceProfile
            ? { deviceProfileWidth: deviceProfile.width, deviceProfileHeight: deviceProfile.height }
            : {}),
          ...(userAgent ? { userAgent } : {}),
        })
      if (!config.pairingRequired) {
        record()
        return true
      }
      if (store.isDevicePaired(deviceId)) {
        record()
        return true
      }
      // Unknown device + pairing on. Record as PENDING only while an enrollment
      // window is open; otherwise reject-and-forget to keep the table clean.
      if (isPairingWindowOpenCached(config.home)) record()
      return false
    },
  )

  wsServer.onConnect(async (sessionId, deviceId, deviceClass, deviceProfile, nav) => {
    store.upsertDevice({
      deviceId,
      deviceClass,
      ...(deviceProfile
        ? { deviceProfileWidth: deviceProfile.width, deviceProfileHeight: deviceProfile.height }
        : {}),
      ...initialFocusFrom(nav),
    })
    sendInitialState(sessionId, deviceId, nav)
  })

  // onResume removed. Reconnect = fresh hello → onConnect path. The
  // supersede-on-deviceId logic in WsServer.handleHello closes any prior
  // socket from the same device before registering the new one.

  wsServer.onDisconnect((sessionId) => {
    // Conversations persist across disconnect. Clean up only transport-local
    // state: voice buffers and pending neighbor-prefetch timers.
    const pending = pendingPrefetchTimers.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      pendingPrefetchTimers.delete(sessionId)
    }
    voiceRelay.destroyClient?.(sessionId)
    console.log(`[disconnect] ${sessionId}`)
  })

  wsServer.onViewing((sessionId, msg) => {
    // Push chatWindow (synchronous, arrives before faces) then faceList +
    // faceUpdate for the new scope. Lazy-boot the app if dormant.
    const window = store.getWindow(msg.scope)
    wsServer.send(
      sessionId,
      msgChatWindow({
        scope: msg.scope,
        conversationId: window.conversationId,
        entries: window.entries.map(toWindowEntry),
      }),
    )

    const appId = scopeToAppId(msg.scope) ?? 'home'

    // Server-SSOT: persist the user's swipe to the devices row so the
    // next reconnect bootstraps from this scope.
    const deviceId = wsServer.getDeviceId(sessionId)
    if (deviceId) {
      store.setDeviceFocus(deviceId, appId, null)
    }

    // Fire-and-forget lazy boot + face push. Errors are logged (not swallowed
    // silently) so ops can see when a scope fails to hydrate; the client's
    // chat already rendered, so the face-missing state is degraded, not broken.
    // A previewed draft (esp. a NEW-APP draft with no live counterpart) is
    // already booted in the DraftRegistry — push directly, never lazy-boot it
    // through the live AppEngine (which has no definition for it).
    const conn = wsServer.getLiveConnections().find((c) => c.sessionId === sessionId)
    const previewedDraft = draftRegistry
      ?.listActiveDrafts()
      .some((d) => d.appId === appId && d.booted && conn?.previewingDraft?.has(d.draftId))
    const already = appEngine.getApp(appId)
    if (previewedDraft || already) {
      pushAppFaces(sessionId, appId)
    } else {
      void appEngine
        .use(appId)
        .then(() => {
          pushAppFaces(sessionId, appId)
        })
        .catch((err) => {
          console.warn(
            `[main] viewing lazy-boot failed for scope ${msg.scope}:`,
            err instanceof Error ? err.message : err,
          )
        })
    }

    // Warm neighbors after a short settle so the next swipe paints from cache.
    // Debouncer ensures rapid swipes only prefetch the final destination's neighbors.
    scheduleNeighborPrefetch(sessionId, appId)
  })

  wsServer.onResetConversation((sessionId, msg) => {
    // kind=DEV resets are handled by the dev-mode block's own handler (it needs
    // the draft registry). This handler owns the regular chat thread only.
    if (msg.kind === ChatKind.DEV) return
    const conv = store.getActive(msg.scope)
    turnQueue.abort(conv.id)
    // Stash requester so the 'reset' listener can stamp it on resetNotice.
    pendingResetRequesters.set(msg.scope, sessionId)
    store.reset(msg.scope) // emits `reset` → broadcasts resetNotice + empty chatWindow
    console.log(`[reset] scope=${msg.scope} requester=${sessionId}`)
  })

  // Older-history pagination. Clients pass beforeSeq; server returns up to
  // `limit` entries below it (default 50). Clients dedupe by id on prepend.
  wsServer.onFetchOlder((sessionId, msg) => {
    const limit = msg.limit && msg.limit > 0 ? msg.limit : 50
    const beforeSeq =
      msg.beforeSeq !== undefined && msg.beforeSeq !== null ? Number(msg.beforeSeq) : 0
    const result = store.getOlder(msg.scope, beforeSeq, limit)
    wsServer.send(
      sessionId,
      msgChatHistory({
        scope: msg.scope,
        conversationId: result.conversationId,
        entries: result.entries.map(toWindowEntry),
        hasMore: result.hasMore,
      }),
    )
  })

  /**
   * Run a single conversation turn. Serialized per-conversation via
   * TurnQueue (two devices viewing the same scope share one queue). The
   * user row is appended BEFORE enqueueing so its broadcast is visible even
   * while the turn is pending behind another one.
   */
  async function runUserTurn(
    wsSessionId: string,
    scope: string,
    userText: string,
    clientMsgId?: string,
    attachments?: Attachment[],
    /**
     * Prefix prepended to the SDK-bound message (NOT the user-visible chat
     * row). Set by `chatInput` when clearing a templated-escalation pending
     * entry so the LLM resumes with the same `[ui_action] face=X tool=Y
     * missing=[...]` context the LLM-escalation path would have left in
     * jsonl. The displayed `text: displayText` on the user row is unchanged
     * — users see their typed reply, not the synthetic context.
     */
    sdkContextPrefix?: string,
  ): Promise<{ id: string; text: string; conversationId: string } | null> {
    const appId = scopeToAppId(scope) ?? 'home'
    const conv = store.getActive(scope)
    const client = wsServer.getLiveConnections().find((c) => c.sessionId === wsSessionId)

    // Display text for scrollback/broadcast. Caption-less image becomes "[image]";
    // the LLM-bound text stays empty so Claude doesn't see the placeholder.
    const displayText = userText || (attachments?.length ? '[image]' : '')

    // User row first — broadcasts to every socket viewing `scope`. clientMsgId
    // deduplicates retries at the DB level. status defaults to 'pending'.
    const originDeviceId = wsServer.getDeviceId(wsSessionId)
    const userRow = store.appendTurn(conv.id, {
      role: 'user',
      text: displayText,
      turnMode: 'direct_user_chat',
      ...(clientMsgId ? { clientMsgId } : {}),
      // Stable deviceId so siblings can attribute the message to its originator.
      ...(originDeviceId ? { originDeviceId } : {}),
    })
    // Dedup'd retry (same clientMsgId): short-circuit without spinning a new turn.
    if (userRow.status !== 'pending') {
      return { id: userRow.id, text: userRow.text, conversationId: conv.id }
    }

    // Lazy-boot. Swallow errors — markTurnFailed surfaces them as a visible row.
    const app = await appEngine.use(appId).catch(() => null)
    if (!app) {
      store.markTurnFailed(userRow.id, 'internal_error')
      return null
    }

    const cwd = syntheticCwdFor(scope, home)
    fs.mkdirSync(cwd, { recursive: true })

    // Hard wall-clock timeout. SDK stream stall cascades: abort queue entry
    // → AgentLoop → adapter → SDK AbortController → visible "(timed out)" row.
    const TURN_TIMEOUT_MS = 90_000
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const turnPromise = runBoundTurn(
      { store, turnQueue, conversationId: conv.id, backend: config.backend },
      async (resume, signal) => {
        store.markTurnRunning(userRow.id)
        const agentLoop = new AgentLoop({
          adapter,
          toolRegistry: app.toolRegistry,
          faceRegistry: app.faceRegistry,
          db: app.db,
          appId,
          sendFaceUpdate,
          faceParamsStore,
          context: app.context,
          config: app.config,
          ...(app.httpClient ? { http: app.httpClient } : {}),
          ...(app.assetCache ? { cacheAsset: app.assetCache } : {}),
          staleness: (taskId: string) => scheduler.getStaleness(appId, taskId),
          faceStaleness: (faceId, params) =>
            scheduler.getFaceStalenessOrNull(appId, faceId, params),
          getMountedFaceIds: () => mountedFaceIdsFor(appId),
        })

        return agentLoop.runTurn({
          conversationId: conv.id,
          message: sdkContextPrefix ? `${sdkContextPrefix}\n\n${userText}` : userText,
          mode: 'direct_user_chat',
          ...(attachments?.length ? { attachments } : {}),
          tools: getToolSchemas(app),
          cwd,
          ...resume,
          ...(originDeviceId ? { originDeviceId } : {}),
          signal,
          context: {
            appId,
            manifest: app.manifest,
            schema: app.schema,
            skill: app.skill,
            turnMode: 'direct_user_chat',
            deviceClass: client?.deviceClass ?? DeviceClass.PHONE,
            ...(appId === 'home' && {
              availableApps: appEngine
                .listApps()
                .filter((m) => m.id !== 'home')
                .map((m) => ({ appId: m.id, name: m.name, description: m.description })),
            }),
            faces: buildFaceContext(app, conv.id, faceParamsStore),
            ...(Object.keys(app.context).length > 0 && { context: app.context }),
          },
        })
      },
    )
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        turnQueue.abort(conv.id)
        const err = new Error('turn_timeout')
        err.name = 'TurnTimeoutError'
        reject(err)
      }, TURN_TIMEOUT_MS)
    })

    try {
      const result = await Promise.race([turnPromise, timeoutPromise])
      if (timeoutId) clearTimeout(timeoutId)
      // The SDK session id is read and bound INSIDE runBoundTurn (in the
      // TurnQueue slot), not here — that's what closes the first-turn double-mint.

      if (!result.success) {
        // {success:false}: abort signal fired (result.text empty) or adapter
        // error event (result.text non-empty). Distinction matters for the
        // failure reason: "aborted" vs. "internal_error".
        if (result.text && result.text.length > 0) {
          console.error('[turn] adapter failure', { scope, convId: conv.id, message: result.text })
          store.markTurnFailed(userRow.id, 'internal_error')
        } else {
          store.markTurnFailed(userRow.id, 'aborted')
        }
        return null
      }

      const row = store.appendTurn(conv.id, {
        role: 'assistant',
        text: result.text,
        turnMode: 'direct_user_chat',
        toolCalls: result.toolCalls,
      })
      store.markTurnCompleted(userRow.id)
      return { id: row.id, text: result.text, conversationId: conv.id }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId)

      const name = err instanceof Error ? err.name : 'Unknown'

      if (name === 'SessionBusyError') {
        // Throws before enqueue: user row is still 'pending', flip to failed.
        wsServer.sendError(
          wsSessionId,
          ProtocolErrorCode.SESSION_BUSY,
          'Too many queued turns',
          5_000,
        )
        store.markTurnFailed(userRow.id, 'internal_error')
        return null
      }
      if (name === 'AbortError') {
        console.log('[turn] aborted', { scope, convId: conv.id })
        store.markTurnFailed(userRow.id, 'aborted')
        return null
      }
      if (name === 'TurnTimeoutError') {
        console.error('[turn] timeout', { scope, convId: conv.id, afterMs: TURN_TIMEOUT_MS })
        store.markTurnFailed(userRow.id, 'sdk_timeout')
        return null
      }

      // Unknown failure — markTurnFailed appends "(internal error)" so the
      // client sees a terminal state instead of a zombie.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[turn] unexpected failure', { scope, convId: conv.id, name, message })
      store.markTurnFailed(userRow.id, 'internal_error')
      return null
    }
  }

  wsServer.onChatInput(async (sessionId, msg) => {
    // Dev-chat → edit-agent. Routed before the live-chat rate limit because dev
    // turns serialize per-draft and don't need the "too many user turns" limiter.
    if (msg.kind === ChatKind.DEV) {
      if (!runDevTurn) {
        // Dev mode is OFF — don't fall through to the normal-chat path.
        // Clear the PWA's "thinking" indicator with an explanatory assistant row.
        console.warn(
          `[dev-turn] dropped: dev message but server dev mode is OFF (scope=${msg.scope ?? 'home'})`,
        )
        wsServer.send(
          sessionId,
          msgChat({
            id: `dev-err-${Date.now()}`,
            scope: msg.scope ?? 'home',
            conversationId: '',
            role: 'assistant',
            text: 'Developer mode is not enabled on the server. Set MOUMANTAI_DEV_MODE=1 (or devMode in config.json) and restart the server.',
            timestamp: new Date().toISOString(),
            kind: 'dev',
          }),
        )
        return
      }
      await runDevTurn(sessionId, msg)
      return
    }

    const rate = wsServer.checkTurnRate(sessionId)
    if (!rate.allowed) {
      wsServer.sendError(
        sessionId,
        ProtocolErrorCode.RATE_LIMITED,
        'Too many user turns',
        rate.retryAfterMs,
      )
      return
    }

    const scope = msg.scope ?? 'home'

    // Safety net: chatInput is proof the device is viewing this scope.
    // Persist focus even if no explicit `viewing` arrived first.
    const cidDeviceId = wsServer.getDeviceId(sessionId)
    if (cidDeviceId) {
      store.setDeviceFocus(cidDeviceId, scopeToAppId(scope) ?? 'home', null)
    }

    // Staleness gate: offline-queued messages stamp `originConversationId`; if
    // it no longer matches the active conversation (another device reset during
    // the outage), reject rather than append as a non-sequitur.
    if (msg.originConversationId && msg.originConversationId.length > 0) {
      const currentConv = store.getActive(scope)
      if (msg.originConversationId !== currentConv.id) {
        wsServer.send(
          sessionId,
          msgError({
            code: ProtocolErrorCode.STALE_CONVERSATION,
            message: 'Conversation advanced while offline',
            ...(msg.clientMsgId ? { clientMsgId: msg.clientMsgId } : {}),
          }),
        )
        return
      }
    }

    // Idempotency: enforced server-side by appendTurn's partial unique index on
    // client_msg_id — duplicate sends are no-op UPSERTs. No in-memory dedup needed.
    //
    // Clear any pending escalation: abort the in-flight LLM turn so an out-of-order
    // question doesn't arrive after the user's reply. Templated-escalation path
    // forwards the synthetic `[ui_action]` context as `sdkContextPrefix` so the
    // SDK sees the same context the LLM path would have written to jsonl.
    const conv = store.getActive(scope)
    const clearedEscalation = clearPendingEscalation(conv.id)
    const sdkContextPrefix = clearedEscalation?.syntheticPrompt

    // Multimodal: validate MIME against Anthropic's supported set and drop if
    // unrecognized. Dropping preserves the text caption rather than crashing the turn.
    const attachments: Attachment[] = []
    if (msg.imageData && msg.imageData.length > 0 && msg.imageMimeType) {
      if (isAnthropicImageMime(msg.imageMimeType)) {
        attachments.push({
          type: 'image',
          data: Buffer.from(msg.imageData),
          mimeType: msg.imageMimeType,
        })
      } else {
        console.warn(`[wire] dropping image attachment with unsupported MIME: ${msg.imageMimeType}`)
      }
    }

    await runUserTurn(
      sessionId,
      scope,
      msg.text,
      msg.clientMsgId,
      attachments.length ? attachments : undefined,
      sdkContextPrefix,
    )
    // No inline `chat` frame — the store event bus broadcasts it.
  })

  /**
   * Forward a relay event stream to the wire: state transitions become
   * `voiceState` frames, audio chunks become binary frames, transcripts
   * kick a fresh user-turn (audio path only), and errors surface as either
   * a typed protocol error (audio overflow) or a `system` chat row.
   *
   * Shared by the `audioInput` and `ttsRequest` event handlers — both relay
   * paths emit the same `VoiceRelayEvent` union.
   */
  async function dispatchVoiceEvents(
    sessionId: string,
    scope: string,
    events: VoiceRelayEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (event.type === 'voiceState') {
        wsServer.setVoiceState(sessionId, event.state)
        wsServer.send(sessionId, msgVoiceState({ state: event.state }))
      } else if (event.type === 'transcript') {
        console.log(`[voice] transcript: ${event.text.length} chars`)
        const rate = wsServer.checkTurnRate(sessionId)
        if (!rate.allowed) {
          wsServer.sendError(
            sessionId,
            ProtocolErrorCode.RATE_LIMITED,
            'Too many user turns',
            rate.retryAfterMs,
          )
          continue
        }
        await runUserTurn(sessionId, scope, event.text)
      } else if (event.type === 'audioChunk') {
        const wsClient = wsServer.getClient(sessionId)
        if (wsClient) {
          const frame = encodeAudioFrame(
            audioChunkHeader({
              format: AudioFormat.PCM16,
              sampleRate: event.sampleRate,
              final: event.final,
            }),
            event.data,
          )
          try {
            wsClient.ws.send(frame)
          } catch {
            /* socket closing */
          }
        }
      } else if (event.type === 'error') {
        console.error(`[voice] error for ${sessionId}:`, event.message)
        if (event.message.startsWith('audio_overflow')) {
          wsServer.sendError(sessionId, ProtocolErrorCode.AUDIO_OVERFLOW, event.message)
        } else {
          // Surface STT/TTS failures as a system row so every connected
          // device on the scope sees the same context.
          const conv = store.getActive(scope)
          store.appendTurn(conv.id, { role: 'system', text: `Voice error: ${event.message}` })
        }
        wsServer.setVoiceState(sessionId, VoiceStateValue.IDLE)
        wsServer.send(sessionId, msgVoiceState({ state: VoiceStateValue.IDLE }))
      }
    }
  }

  wsServer.onAudioInput(async (sessionId, header, payload) => {
    // Validator at the WS boundary already guaranteed PCM16 / 16 kHz / non-
    // empty scope; the relay's internal AudioCodec spec is decoupled from
    // the proto enum to keep the OpenAI adapter's API stable.
    const events = await voiceRelay.handleAudioInput({
      voiceKey: sessionId,
      scope: header.scope,
      data: payload,
      format: 'pcm16',
      sampleRate: header.sampleRate,
      final: header.final,
    })
    await dispatchVoiceEvents(sessionId, header.scope, events)
  })

  // On-demand TTS: client requests speech synthesis for a message.
  wsServer.onTTSRequest(async (sessionId, msg) => {
    const events = await voiceRelay.synthesizeResponse(msg.text, sessionId)
    const scope = wsServer.getActiveScope(sessionId) ?? 'home'
    await dispatchVoiceEvents(sessionId, scope, events)
  })

  wsServer.onInvokeTool(async (sessionId, msg) => {
    if (!msg.toolName) return

    // The active scope is the source of truth for which app's tool registry
    // we route into. Fall back to the session's tracked active scope when
    // the message itself doesn't carry enough info, then to home.
    const sessionScope = wsServer.getActiveScope(sessionId) ?? 'home'
    const appId = scopeToAppId(sessionScope) ?? 'home'

    // Swallow boot errors — an invocation whose target app won't boot is a
    // silent no-op rather than a fatal (no user is waiting on a turn here).
    const app = await appEngine.use(appId).catch(() => null)
    if (!app) return

    const scope = appIdToScope(appId)
    const conv = store.getActive(scope)
    const client = wsServer.getLiveConnections().find((c) => c.sessionId === sessionId)

    // The proto Struct deserializes to a plain JS object; pass it straight
    // through as args. The dispatcher already resolved any path placeholders.
    const args = (msg.args ?? {}) as Record<string, unknown>

    // Escalation closure: invoked when executeTool reports missing-required args.
    // Mirrors runUserTurn's AgentLoop shape so SDK session resume is identical.
    const cwd = syntheticCwdFor(scope, home)
    fs.mkdirSync(cwd, { recursive: true })
    const runEscalationTurn = async (promptText: string, signal?: AbortSignal) => {
      // Re-read the binding here, not from the outer snapshot: runEscalationTurn
      // executes inside the action-handler's TurnQueue slot for this
      // conversation, so this read is in-lock (and the matching bind in
      // action-handler is too) — which keeps escalation off the double-mint.
      const resume = sdkResumeArgs(store.getById(conv.id) ?? conv, config.backend)
      const agentLoop = new AgentLoop({
        adapter,
        toolRegistry: app.toolRegistry,
        faceRegistry: app.faceRegistry,
        db: app.db,
        appId,
        sendFaceUpdate,
        faceParamsStore,
        context: app.context,
        config: app.config,
        ...(app.httpClient ? { http: app.httpClient } : {}),
        ...(app.assetCache ? { cacheAsset: app.assetCache } : {}),
        getMountedFaceIds: () => mountedFaceIdsFor(appId),
      })
      const result = await agentLoop.runTurn({
        conversationId: conv.id,
        message: promptText,
        mode: 'direct_user_chat',
        tools: getToolSchemas(app),
        cwd,
        ...resume,
        ...(signal ? { signal } : {}),
        context: {
          appId,
          manifest: app.manifest,
          schema: app.schema,
          skill: app.skill,
          turnMode: 'direct_user_chat',
          deviceClass: client?.deviceClass ?? DeviceClass.PHONE,
          ...(appId === 'home' && {
            availableApps: appEngine
              .listApps()
              .filter((m) => m.id !== 'home')
              .map((m) => ({ appId: m.id, name: m.name, description: m.description })),
          }),
          faces: buildFaceContext(app, conv.id, faceParamsStore),
          ...(Object.keys(app.context).length > 0 && { context: app.context }),
        },
      })
      return {
        success: result.success,
        text: result.text,
        toolCalls: result.toolCalls,
        ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
      }
    }

    // Fires the moment escalation is detected so chat opens within ~50ms of tap,
    // before the 1–3s LLM turn starts. Also fires on duplicate-tap early-block.
    const onEscalationStarted = (escScope: string) => {
      wsServer.send(sessionId, msgUiActionEscalated({ scope: escScope }))
    }

    // Forward originDeviceId so `view_<faceId>` calls setDeviceFocus on this
    // device — without it, card-tap navigation doesn't auto-switch the face.
    const originDeviceId = wsServer.getDeviceId(sessionId)
    const outcome = await handleInvokeTool(msg.toolName, args, {
      toolRegistry: app.toolRegistry,
      faceRegistry: app.faceRegistry,
      db: app.db,
      appId,
      sendFaceUpdate,
      faceParamsStore,
      context: app.context,
      config: app.config,
      backend: config.backend,
      ...(app.httpClient ? { http: app.httpClient } : {}),
      ...(app.assetCache ? { cacheAsset: app.assetCache } : {}),
      staleness: (taskId: string) => scheduler.getStaleness(appId, taskId),
      faceStaleness: (faceId, params) => scheduler.getFaceStalenessOrNull(appId, faceId, params),
      getMountedFaceIds: () => mountedFaceIdsFor(appId),
      ...(originDeviceId ? { originDeviceId } : {}),
      dedupStore,
      conversationStore: store,
      conversationId: conv.id,
      sourceFaceId: msg.sourceFaceId,
      clientRequestId: msg.clientRequestId,
      ...(msg.escalationPrompt !== undefined ? { escalationPrompt: msg.escalationPrompt } : {}),
      turnQueue,
      runEscalationTurn,
      onEscalationStarted,
    })

    // Surface tool errors as typed wire errors. UNSPECIFIED used because
    // ProtocolErrorCode has no INTERNAL value. Escalation hint fires via
    // onEscalationStarted, not here.
    if (outcome.error) {
      wsServer.send(
        sessionId,
        msgError({
          code: ProtocolErrorCode.UNSPECIFIED,
          message: `[${outcome.error.code}] ${outcome.error.message}`,
        }),
      )
    }
  })

  // Attach WS to HTTP
  wsServer.attach(httpServer)

  return {
    httpServer,
    wsServer,
    appEngine,
    store,
    turnQueue,
    platformDb,
    voiceRelay,
    adapter,
    config,
    home,
    fileWatcher,
    scheduler,
    draftStore,
    draftRegistry,
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startServer(portOverride?: number): Promise<ServerComponents> {
  const components = await createAppServer(portOverride ? { port: portOverride } : undefined)
  const { httpServer, appEngine, config, wsServer } = components

  httpServer.listen(config.port, () => {
    const apps = appEngine.listApps()
    const pluginCount = apps.filter((a) => a.id !== 'home').length
    console.log(`Moumantai server listening on port ${config.port}`)
    console.log(`  Home:    ${config.home}`)
    console.log(`  Backend: ${config.backend}`)
    console.log(
      `  Apps:    ${apps.map((a) => a.id).join(', ')} (${pluginCount} plugin${pluginCount !== 1 ? 's' : ''})`,
    )
  })

  // Optional RSS soak: set `MOUMANTAI_RSS_LOG_MS` to a positive ms to log
  // memoryUsage periodically. Off by default; not for production.
  const rssLogMs = Number(process.env.MOUMANTAI_RSS_LOG_MS ?? 0)
  if (Number.isFinite(rssLogMs) && rssLogMs > 0) {
    const t = setInterval(() => {
      const m = process.memoryUsage()
      console.log(
        JSON.stringify({
          event: 'rss',
          rssMb: Math.round(m.rss / 1e6),
          heapUsedMb: Math.round(m.heapUsed / 1e6),
          heapTotalMb: Math.round(m.heapTotal / 1e6),
          externalMb: Math.round(m.external / 1e6),
          sessions: wsServer.getClientCount(),
          apps: appEngine.listApps().length,
        }),
      )
    }, rssLogMs)
    t.unref?.()
  }

  // Graceful shutdown: stop accepting work, drain in-flight turns with a
  // bounded deadline, then close transport + adapters + DB handles in order.
  const shutdown = async (signal?: string) => {
    console.log(`Shutting down...${signal ? ` (signal=${signal})` : ''}`)
    components.fileWatcher?.stop()

    // Best-effort drain: 2s deadline before evicting apps and closing DB handles.
    const drainDeadline = new Promise<void>((r) => setTimeout(r, 2000))
    const drainAll = Promise.all(
      appEngine
        .listApps()
        .flatMap((a) =>
          components.store
            .activeConversationIdsForApp(a.id)
            .map((c) => components.turnQueue.drain(c)),
        ),
    ).then(() => {})
    await Promise.race([drainAll, drainDeadline])

    components.scheduler.stop()
    appEngine.shutdown()
    await components.wsServer.close()
    await components.adapter.disconnect()
    try {
      const handle = (components.platformDb as unknown as { $client?: { close?: () => void } })
        .$client
      handle?.close?.()
    } catch {
      /* already closed */
    }

    httpServer.close(() => {
      console.log('Server closed.')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Diagnostics only — behavior unchanged; leaves a trace of why the process exited.
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException — process will exit:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection — process will exit:', reason)
    process.exit(1)
  })
  process.on('exit', (code) => {
    console.log(`[lifecycle] process exit code=${code}`)
  })

  return components
}

// Auto-start when run directly
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('main.ts') || process.argv[1].endsWith('main.js'))

if (isDirectRun) {
  startServer()
}
