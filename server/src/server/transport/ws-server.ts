/**
 * WebSocket server implementing the ServerTransport interface.
 *
 * `deviceId` is the durable identity (UUIDv4, client-generated, persisted
 * locally). Each WebSocket gets a fresh server-issued `sessionId` as an
 * ephemeral routing handle.
 *
 * Supersede on reconnect: a ClientHello for an already-live deviceId closes
 * the old socket with code 1000 'superseded' without firing disconnect
 * handlers — the new connection IS the continuation.
 *
 * No grace window, no replay buffer, no resume credentials. Reconnect = fresh
 * handshake + full snapshot push (appList + chatWindow + faceList + faceUpdate).
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server as HttpServer } from 'http'
import type { ServerTransport } from './types.js'
import type {
  AudioChunkHeader,
  ChatInput,
  InvokeToolMsg,
  TTSRequest,
  ViewingMsg,
  ResetConversationMsg,
  FetchOlderMsg,
  PreviewOptInRequest,
  DraftReloadRequest,
  DraftPromoteRequest,
  DraftDiscardRequest,
  DraftTurnCancelRequest,
  ClientHello,
  ClientMessage,
  ServerMessage,
  DeviceProfile,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  AudioFormat,
  BinaryFrameType,
  ClientMessageSchema,
  CloseCode,
  ServerMessageSchema,
  DeviceClass,
  ProtocolErrorCode,
  SizeClass,
  VoiceStateValue,
} from '@moumantai/protocol/generated/moumantai/v1'
import { decodeAudioHeader, parseBinaryFrame } from '@moumantai/protocol'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { msgHelloOk, msgError } from './messages.js'

/**
 * Navigation fields extracted from `ClientHello` and forwarded to connect
 * handlers. Server-internal — no wire equivalent.
 */
export interface HelloNavIntent {
  currentAppId?: string
  currentFaceId?: string
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tracked state for a connected client (exposed via onConnect handlers + getClient). */
export interface ConnectedClient {
  ws: WebSocket
  deviceClass: DeviceClass
  deviceProfile: DeviceProfile | undefined
}

/**
 * Live connection state, one record per physical device keyed by `sessionId`.
 * The stable identity is `deviceId`; supersede-on-reconnect ensures at most
 * one live connection per deviceId.
 *
 * No resume credentials, no replay buffer, no grace window. Reconnect = fresh
 * registration + full snapshot from the SSOT. Voice state is per-connection
 * (a closed socket has no "still listening"); resets to IDLE on reconnect.
 */
interface SessionState {
  /** Server-generated handle for routing; sent in ServerHello. */
  sessionId: string
  /** Stable per-device id from `ClientHello.device_id`; server-generated UUID when the client omits it. */
  deviceId: string

  ws: WebSocket
  deviceClass: DeviceClass
  deviceProfile: DeviceProfile | undefined

  /** Sliding window of turn-start timestamps for rate limiting (per device). */
  turnTimestamps: number[]
  /** Per-second binary frame bucket. */
  binaryFrameBucket: { startMs: number; count: number }

  /** Scope most recently declared via `viewing` (or inferred from `chatInput`). Used by `broadcastToScope`. */
  activeScope?: string

  /**
   * Face this client is currently rendering within `activeScope`. Initialized
   * from `ClientHello.current_face_id`; updated when the broadcast layer
   * pushes `createSurface`. Read by the refresh scheduler to gate face-bound
   * workers.
   */
  currentFaceId?: string

  /** Params the current face is mounted with. Set by the broadcast layer alongside `currentFaceId`. */
  currentFaceParams?: Record<string, unknown>

  /** Per-connection voice pipeline state. Initialized to IDLE. */
  voiceState: VoiceStateValue
  /** Opaque id for the currently-in-flight voice turn, if any. */
  voiceTurnId?: string

  /** True while ws.bufferedAmount exceeds the threshold. Consumers skip disposable broadcasts. */
  backpressurePaused: boolean

  /**
   * Draft ids this client is previewing (PWA dev mode only). Read by the
   * broadcast layer to route the draft variant to this session only.
   */
  previewingDraft: Set<string>
}

// Callback types
type InvokeToolHandler = (sessionId: string, message: InvokeToolMsg) => void
type ConnectHandler = (
  sessionId: string,
  deviceId: string,
  deviceClass: DeviceClass,
  deviceProfile: DeviceProfile | undefined,
  nav?: HelloNavIntent,
) => void
type DisconnectHandler = (sessionId: string) => void
/**
 * Admission gate called before any session/ServerHello. Return true to allow,
 * false to close with `CLOSE_CODE_PAIRING_REQUIRED`. Injected by `main.ts`;
 * the transport holds no policy itself. `clientSuppliedId: false` means the
 * client omitted a deviceId (server minted one) — such devices are unpairable.
 * Defaults to always-allow when unset.
 */
type PairingResolver = (info: {
  deviceId: string
  clientSuppliedId: boolean
  deviceClass: DeviceClass
  deviceProfile?: DeviceProfile
  /** User-Agent from the WebSocket handshake (for `device list` display). */
  userAgent?: string
}) => boolean | Promise<boolean>
type ChatInputHandler = (sessionId: string, message: ChatInput) => void
type AudioInputHandler = (sessionId: string, header: AudioChunkHeader, payload: Buffer) => void
type TTSRequestHandler = (sessionId: string, message: TTSRequest) => void
type ViewingHandler = (sessionId: string, message: ViewingMsg) => void
type ResetConversationHandler = (sessionId: string, message: ResetConversationMsg) => void
type FetchOlderHandler = (sessionId: string, message: FetchOlderMsg) => void
type PreviewOptInHandler = (sessionId: string, message: PreviewOptInRequest) => void
type DraftReloadHandler = (sessionId: string, message: DraftReloadRequest) => void
type DraftPromoteHandler = (sessionId: string, message: DraftPromoteRequest) => void
type DraftDiscardHandler = (sessionId: string, message: DraftDiscardRequest) => void
type DraftTurnCancelHandler = (sessionId: string, message: DraftTurnCancelRequest) => void

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_TURNS_PER_30S = 5
const DEFAULT_MAX_BINARY_FRAMES_PER_SEC = 200
const DEFAULT_BACKPRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_INBOUND_TEXT_BYTES = 256 * 1024
const DEFAULT_MAX_INBOUND_BINARY_BYTES = 2 * 1024 * 1024
const RATE_LIMIT_TURN_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WsServerOptions {
  /** UUID generator (injectable for testing). */
  generateId?: () => string
  /** Clock (injectable for testing). Returns unix ms. */
  now?: () => number
  /** Handshake timeout (default 5000). */
  handshakeTimeoutMs?: number
  /** Max user turns per 30s per device (default 5). */
  maxTurnsPer30s?: number
  /** Max binary frames per second per session (default 200). */
  maxBinaryFramesPerSec?: number
  /** ws.bufferedAmount threshold over which backpressure pause engages (default 1 MiB). */
  backpressureThresholdBytes?: number
  /** Max inbound JSON text frame bytes (default 256 KiB). */
  maxInboundTextBytes?: number
  /** Max inbound binary frame bytes (default 2 MiB). */
  maxInboundBinaryBytes?: number
  /** Advertise dev-mode to clients in the ServerHello (default false). */
  devModeEnabled?: boolean
}

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------

export class WsServer implements ServerTransport {
  private wss: WebSocketServer | null = null
  private sessions = new Map<string, SessionState>()

  // Callback registrations
  private invokeToolHandlers: InvokeToolHandler[] = []
  private connectHandlers: ConnectHandler[] = []
  private disconnectHandlers: DisconnectHandler[] = []
  // Pairing gate; default always-allow keeps pairing opt-in / tests untouched.
  private pairingResolver: PairingResolver = () => true
  private chatInputHandlers: ChatInputHandler[] = []
  private audioInputHandlers: AudioInputHandler[] = []
  private ttsRequestHandlers: TTSRequestHandler[] = []
  private viewingHandlers: ViewingHandler[] = []
  private resetConversationHandlers: ResetConversationHandler[] = []
  private fetchOlderHandlers: FetchOlderHandler[] = []
  private previewOptInHandlers: PreviewOptInHandler[] = []
  private draftReloadHandlers: DraftReloadHandler[] = []
  private draftPromoteHandlers: DraftPromoteHandler[] = []
  private draftDiscardHandlers: DraftDiscardHandler[] = []
  private draftTurnCancelHandlers: DraftTurnCancelHandler[] = []

  private generateId: () => string
  private now: () => number
  private handshakeTimeoutMs: number
  private maxTurnsPer30s: number
  private maxBinaryFramesPerSec: number
  private backpressureThresholdBytes: number
  private maxInboundTextBytes: number
  private maxInboundBinaryBytes: number
  private devModeEnabled: boolean

  constructor(options?: WsServerOptions) {
    this.generateId = options?.generateId ?? (() => crypto.randomUUID())
    this.now = options?.now ?? Date.now
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.maxTurnsPer30s = options?.maxTurnsPer30s ?? DEFAULT_MAX_TURNS_PER_30S
    this.maxBinaryFramesPerSec = options?.maxBinaryFramesPerSec ?? DEFAULT_MAX_BINARY_FRAMES_PER_SEC
    this.backpressureThresholdBytes =
      options?.backpressureThresholdBytes ?? DEFAULT_BACKPRESSURE_THRESHOLD_BYTES
    this.maxInboundTextBytes = options?.maxInboundTextBytes ?? DEFAULT_MAX_INBOUND_TEXT_BYTES
    this.maxInboundBinaryBytes = options?.maxInboundBinaryBytes ?? DEFAULT_MAX_INBOUND_BINARY_BYTES
    this.devModeEnabled = options?.devModeEnabled ?? false
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  attach(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ server: httpServer, handleProtocols: handleSubprotocol })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
  }

  listen(port: number): WebSocketServer {
    this.wss = new WebSocketServer({ port, handleProtocols: handleSubprotocol })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
    return this.wss
  }

  close(): Promise<void> {
    // Cleanly tear down every session.
    for (const session of [...this.sessions.values()]) {
      this.destroySession(session, 'server-shutdown')
    }
    return new Promise((resolve, reject) => {
      if (!this.wss) {
        resolve()
        return
      }
      this.wss.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // -----------------------------------------------------------------------
  // ServerTransport interface
  // -----------------------------------------------------------------------

  /**
   * Best-effort send to the live socket. No seq, no replay buffer.
   * Dropped frames are recovered on reconnect via the full snapshot
   * (chatWindow + faceList). Returns silently for unknown or closed sessions.
   */
  send(sessionId: string, message: ServerMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sendToSession(session, message)
  }

  onInvokeTool(handler: InvokeToolHandler): void {
    this.invokeToolHandlers.push(handler)
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler)
  }

  /** Inject the pairing gate (see {@link PairingResolver}). Replaces any prior. */
  setPairingResolver(resolver: PairingResolver): void {
    this.pairingResolver = resolver
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.push(handler)
  }

  // -----------------------------------------------------------------------
  // Extended API
  // -----------------------------------------------------------------------

  /** Send a disposable message (no seq, no buffer) to every live session. */
  broadcast(message: ServerMessage): void {
    const payload = this.encodeFrame(message)
    if (!payload) return
    for (const session of this.sessions.values()) {
      if (session.ws.readyState === WebSocket.OPEN) {
        this.rawSend(session, payload)
      }
    }
  }

  /** Send `message` to every live session whose `activeScope === scope`. Offline devices recover on reconnect. */
  broadcastToScope(scope: string, message: ServerMessage): void {
    for (const session of this.sessions.values()) {
      if (session.activeScope !== scope) continue
      this.sendToSession(session, message)
    }
  }

  /** Set the active scope for a session (exposed for integration tests). */
  setActiveScope(sessionId: string, scope: string | undefined): void {
    const s = this.sessions.get(sessionId)
    if (s) s.activeScope = scope
  }

  /** Return the active scope for a session, or undefined if unknown. */
  getActiveScope(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.activeScope
  }

  /** Return the deviceId for a session, or undefined if unknown. */
  getDeviceId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.deviceId
  }

  /**
   * Find the live sessionId for a deviceId, or undefined if the device is
   * offline. Supersede-on-reconnect guarantees at most one live socket per
   * deviceId. `undefined` → mutation persists to `devices.last_active_app`
   * and is picked up on reconnect.
   */
  getSessionByDeviceId(deviceId: string): string | undefined {
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && session.ws.readyState === WebSocket.OPEN) {
        return session.sessionId
      }
    }
    return undefined
  }

  /** Enumerate currently-live connections. Returns a snapshot so callers can iterate without locking. */
  getLiveConnections(): Array<{
    sessionId: string
    deviceId: string
    deviceClass: DeviceClass
    deviceProfile: DeviceProfile | undefined
    sizeClass: SizeClass
    voiceState: VoiceStateValue
    voiceTurnId?: string
    previewingDraft: ReadonlySet<string>
  }> {
    const out = []
    for (const s of this.sessions.values()) {
      if (s.ws.readyState !== WebSocket.OPEN) continue
      out.push({
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        deviceClass: s.deviceClass,
        deviceProfile: s.deviceProfile,
        sizeClass: classifyWidth(s.deviceProfile?.width ?? 390),
        voiceState: s.voiceState,
        ...(s.voiceTurnId ? { voiceTurnId: s.voiceTurnId } : {}),
        previewingDraft: s.previewingDraft,
      })
    }
    return out
  }

  /** Voice pipeline state per session. */
  getVoiceState(sessionId: string): VoiceStateValue | undefined {
    return this.sessions.get(sessionId)?.voiceState
  }
  setVoiceState(sessionId: string, value: VoiceStateValue): void {
    const s = this.sessions.get(sessionId)
    if (s) s.voiceState = value
  }
  getVoiceTurnId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.voiceTurnId
  }
  setVoiceTurnId(sessionId: string, id: string | undefined): void {
    const s = this.sessions.get(sessionId)
    if (s) s.voiceTurnId = id
  }

  /** Send a structured error message. Does not close the socket. */
  sendError(
    sessionId: string,
    code: ProtocolErrorCode,
    message: string,
    retryAfterMs?: number,
  ): void {
    this.send(
      sessionId,
      msgError({
        code,
        message,
        retryAfterMs,
      }),
    )
  }

  onChatInput(handler: ChatInputHandler): void {
    this.chatInputHandlers.push(handler)
  }

  /** Called when a client declares its active scope via `viewing`. */
  onViewing(handler: ViewingHandler): void {
    this.viewingHandlers.push(handler)
  }

  /** Called when a client asks to reset the conversation for a scope. */
  onResetConversation(handler: ResetConversationHandler): void {
    this.resetConversationHandlers.push(handler)
  }

  /** Register handler for client-driven older-history pagination requests. */
  onFetchOlder(handler: FetchOlderHandler): void {
    this.fetchOlderHandlers.push(handler)
  }

  // Draft-editing (dev mode) client→server requests.
  onPreviewOptIn(handler: PreviewOptInHandler): void {
    this.previewOptInHandlers.push(handler)
  }
  onDraftReload(handler: DraftReloadHandler): void {
    this.draftReloadHandlers.push(handler)
  }
  onDraftPromote(handler: DraftPromoteHandler): void {
    this.draftPromoteHandlers.push(handler)
  }
  onDraftDiscard(handler: DraftDiscardHandler): void {
    this.draftDiscardHandlers.push(handler)
  }
  onDraftTurnCancel(handler: DraftTurnCancelHandler): void {
    this.draftTurnCancelHandlers.push(handler)
  }

  /**
   * Add/remove a draft id from a session's preview set. Returns false if the
   * session is unknown. Read by the broadcast layer (getLiveConnections) to
   * route the draft variant to just this session.
   */
  setPreviewingDraft(sessionId: string, draftId: string, optIn: boolean): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    if (optIn) s.previewingDraft.add(draftId)
    else s.previewingDraft.delete(draftId)
    return true
  }

  /** Sessions currently previewing a given draft — for refresh-task gating + broadcasts. */
  sessionsPreviewingDraft(draftId: string): string[] {
    const out: string[] = []
    for (const s of this.sessions.values()) {
      if (s.ws.readyState === WebSocket.OPEN && s.previewingDraft.has(draftId))
        out.push(s.sessionId)
    }
    return out
  }

  onAudioInput(handler: AudioInputHandler): void {
    this.audioInputHandlers.push(handler)
  }

  onTTSRequest(handler: TTSRequestHandler): void {
    this.ttsRequestHandlers.push(handler)
  }

  /**
   * Public snapshot of a connected client (sessionId + raw `WebSocket` +
   * device + capability metadata captured at handshake).
   */
  getClient(sessionId: string): ConnectedClient | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    return {
      ws: s.ws,
      deviceClass: s.deviceClass,
      deviceProfile: s.deviceProfile,
    }
  }

  getClientCount(): number {
    let count = 0
    for (const s of this.sessions.values()) {
      if (s.ws.readyState === WebSocket.OPEN) count += 1
    }
    return count
  }

  /** True while backpressure is paused for this session. Callers may skip disposable updates. */
  isBackpressurePaused(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.backpressurePaused ?? false
  }

  /**
   * Check whether a new user turn is within the sliding-window rate limit.
   * On `allowed: false`, callers should send a `rate_limited` error with
   * the returned `retryAfterMs`.
   */
  checkTurnRate(sessionId: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const session = this.sessions.get(sessionId)
    if (!session) return { allowed: false, retryAfterMs: 0 }
    const nowMs = this.now()
    const windowStart = nowMs - RATE_LIMIT_TURN_WINDOW_MS
    session.turnTimestamps = session.turnTimestamps.filter((t) => t >= windowStart)
    if (session.turnTimestamps.length >= this.maxTurnsPer30s) {
      const oldest = session.turnTimestamps[0]!
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldest + RATE_LIMIT_TURN_WINDOW_MS - nowMs),
      }
    }
    session.turnTimestamps.push(nowMs)
    return { allowed: true }
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let boundSessionId: string | null = null
    const userAgent = (req.headers['user-agent'] as string | undefined) || undefined
    // Guard against a second pre-handshake frame racing a duplicate hello
    // while the async pairing gate is in flight.
    let handshakeInProgress = false

    const handshakeTimer = setTimeout(() => {
      if (!boundSessionId) {
        ws.close(CloseCode.HANDSHAKE_TIMEOUT, 'Handshake timeout')
      }
    }, this.handshakeTimeoutMs)

    // All frames are binary (`moumantai.v1.proto` subprotocol). Audio/image
    // payloads use a leading 1-byte type prefix (AUDIO = 1, IMAGE = 2 —
    // BinaryFrameType). Proto envelope tags start at 0x0a, so the check is
    // unambiguous.
    ws.on('message', async (data, isBinary) => {
      const session = boundSessionId ? this.sessions.get(boundSessionId) : null
      const buf = data as Buffer

      // Text frames are rejected — the subprotocol is binary-only.
      if (!isBinary) {
        if (session) {
          this.sendError(
            session.sessionId,
            ProtocolErrorCode.FRAME_TOO_LARGE,
            'Text frames not supported on this subprotocol',
          )
          ws.close(CloseCode.FRAME_TOO_LARGE, 'frame_too_large')
        } else {
          ws.close(CloseCode.INVALID_HELLO, 'Invalid ClientHello')
        }
        return
      }

      const cap = session ? this.maxInboundBinaryBytes : this.maxInboundTextBytes
      if (buf.length > cap) {
        if (session) {
          this.sendError(
            session.sessionId,
            ProtocolErrorCode.FRAME_TOO_LARGE,
            'Binary frame exceeded server cap',
          )
        }
        ws.close(CloseCode.FRAME_TOO_LARGE, 'frame_too_large')
        return
      }

      // Pre-handshake: the first frame must be a hello envelope.
      if (!session) {
        if (handshakeInProgress) return
        let decoded: ClientMessage | null = null
        try {
          decoded = fromBinary(ClientMessageSchema, buf)
        } catch {
          decoded = null
        }
        if (!decoded || decoded.payload.case !== 'hello') return
        clearTimeout(handshakeTimer)
        const hello = decoded.payload.value
        if (!isValidClientHello(hello)) {
          ws.close(CloseCode.INVALID_HELLO, 'Invalid ClientHello')
          return
        }
        // Latch before the await: routes later frames on success; socket is
        // already closed on rejection. Either way the gate stays closed.
        handshakeInProgress = true
        const bound = await this.handleHello(ws, hello, userAgent)
        if (bound) boundSessionId = bound
        return
      }

      // Post-handshake: disambiguate AUDIO frames from envelopes by the first byte.
      const first = buf.length > 0 ? buf[0] : -1
      const isAudioBinaryFrame = first === BinaryFrameType.AUDIO
      if (isAudioBinaryFrame) {
        if (!this.consumeBinaryFrameBudget(session)) {
          this.sendError(
            session.sessionId,
            ProtocolErrorCode.RATE_LIMITED,
            'Too many binary frames',
            1000,
          )
          return
        }
        this.handleBinaryFrame(session.sessionId, buf)
        return
      }

      // IMAGE frames (0x02): image attachments ride on `ChatInput.image_data`.
      // Drop explicitly rather than attempting to decode as an envelope.
      if (first === BinaryFrameType.IMAGE) return

      let decoded: ClientMessage | null = null
      try {
        decoded = fromBinary(ClientMessageSchema, buf)
      } catch {
        decoded = null
      }
      if (!decoded) return
      this.routeClientMessage(session, decoded)
    })

    ws.on('close', () => {
      clearTimeout(handshakeTimer)
      if (boundSessionId) {
        const session = this.sessions.get(boundSessionId)
        // Tear down immediately — no grace window. After a supersede,
        // session.ws !== ws, so we skip the old socket.
        if (session && session.ws === ws) {
          this.destroySession(session, 'socket-closed')
        }
      }
    })

    ws.on('error', () => {
      clearTimeout(handshakeTimer)
      // Followed by close; tear-down happens there.
    })
  }

  /**
   * Register the live connection, superseding any prior socket for the same
   * deviceId. Returns the bound sessionId on success, null on rejection.
   * State recovery on reconnect = full snapshot from DB.
   */
  private async handleHello(
    ws: WebSocket,
    hello: ClientHello,
    userAgent?: string,
  ): Promise<string | null> {
    const deviceId = this.resolveDeviceId(hello)
    const clientSuppliedId = !!(hello.deviceId && hello.deviceId.length > 0)

    // Pairing gate — runs before any session/ServerHello. Default is
    // always-allow. A server-minted id means the device is unpairable.
    const allowed = await this.pairingResolver({
      deviceId,
      clientSuppliedId,
      deviceClass: hello.deviceClass,
      deviceProfile: hello.deviceProfile,
      userAgent,
    })
    if (!allowed) {
      try {
        ws.close(CloseCode.PAIRING_REQUIRED, 'pairing_required')
      } catch {
        /* socket may already be gone */
      }
      return null
    }

    // Supersede any prior live socket for this device. 'superseded' tells
    // the client the disconnect is intentional. Disconnect handlers are NOT
    // fired — the new connection IS the continuation.
    const prior = this.findSessionByDeviceId(deviceId)
    if (prior) {
      try {
        prior.ws.close(1000, 'superseded')
      } catch {
        /* old socket may already be closing */
      }
      this.sessions.delete(prior.sessionId)
    }

    const session = this.createSession(ws, hello, deviceId)
    this.sessions.set(session.sessionId, session)

    const helloOk = msgHelloOk({
      sessionId: session.sessionId,
      devModeEnabled: this.devModeEnabled,
    })
    ws.send(toBinary(ServerMessageSchema, helloOk))

    const nav = extractNavIntent(hello)
    for (const handler of this.connectHandlers) {
      handler(session.sessionId, session.deviceId, session.deviceClass, session.deviceProfile, nav)
    }
    return session.sessionId
  }

  /** Linear scan for a deviceId match. With supersede semantics, at most one. */
  private findSessionByDeviceId(deviceId: string): SessionState | undefined {
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) return s
    }
    return undefined
  }

  private createSession(ws: WebSocket, hello: ClientHello, deviceId: string): SessionState {
    const nowMs = this.now()
    return {
      sessionId: this.generateId(),
      deviceId,
      ws,
      deviceClass: hello.deviceClass,
      deviceProfile: hello.deviceProfile,
      turnTimestamps: [],
      binaryFrameBucket: { startMs: nowMs, count: 0 },
      voiceState: VoiceStateValue.IDLE,
      backpressurePaused: false,
      previewingDraft: new Set<string>(),
      // activeScope: set by the first ViewingMsg or chatInput.
      // currentFaceParams: set by the broadcast layer via setCurrentFaceMount.
      ...(hello.currentFaceId !== undefined && { currentFaceId: hello.currentFaceId }),
    }
  }

  // -------------------------------------------------------------------------
  // Mounted-set tracking (refresh-scheduler integration)
  // -------------------------------------------------------------------------

  /**
   * Update the current face mount for a session. Called by the broadcast layer
   * when pushing `createSurface`. Idempotent; missing session is a no-op.
   */
  setCurrentFaceMount(sessionId: string, faceId: string, params: Record<string, unknown>): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.currentFaceId = faceId
    s.currentFaceParams = params
  }

  /**
   * Aggregate all sessions that have both `activeScope` and `currentFaceId`
   * into a mounted-set snapshot. Sessions still in pre-mount phase are omitted.
   * Read by the refresh scheduler for `mountedOnly` task gating.
   */
  getMountedSet(): {
    deviceId: string
    scope: string
    faceId: string
    params: Record<string, unknown>
  }[] {
    const out: {
      deviceId: string
      scope: string
      faceId: string
      params: Record<string, unknown>
    }[] = []
    for (const s of this.sessions.values()) {
      if (!s.activeScope || !s.currentFaceId) continue
      out.push({
        deviceId: s.deviceId,
        scope: s.activeScope,
        faceId: s.currentFaceId,
        params: s.currentFaceParams ?? {},
      })
    }
    return out
  }

  /**
   * Resolve the deviceId from a ClientHello. Uses `crypto.randomUUID()`
   * directly (not the injectable `generateId`, which is sequenced in tests
   * alongside sessionId).
   */
  private resolveDeviceId(hello: ClientHello): string {
    return hello.deviceId && hello.deviceId.length > 0 ? hello.deviceId : crypto.randomUUID()
  }

  // -----------------------------------------------------------------------
  // Message routing
  // -----------------------------------------------------------------------

  private routeClientMessage(session: SessionState, msg: ClientMessage): void {
    const sessionId = session.sessionId
    const payload = msg.payload

    switch (payload.case) {
      case 'hello':
        // Client tried to handshake twice on the same socket — ignore.
        return

      case 'chatInput': {
        // Update activeScope so subsequent broadcasts hit this socket.
        // Also covers clients that never sent an explicit `viewing` frame.
        if (payload.value.scope) {
          session.activeScope = payload.value.scope
        }
        for (const handler of this.chatInputHandlers) {
          handler(sessionId, payload.value)
        }
        return
      }

      case 'viewing': {
        if (payload.value.scope) {
          session.activeScope = payload.value.scope
        }
        for (const handler of this.viewingHandlers) {
          handler(sessionId, payload.value)
        }
        return
      }

      case 'resetConversation':
        for (const handler of this.resetConversationHandlers) {
          handler(sessionId, payload.value)
        }
        return

      case 'ttsRequest':
        for (const handler of this.ttsRequestHandlers) {
          handler(sessionId, payload.value)
        }
        return

      case 'invokeTool': {
        // sourceFaceId is the face id, not a full scope; main.ts updates
        // activeScope when the handler resolves the appId.
        if (payload.value.sourceFaceId) {
        }
        for (const handler of this.invokeToolHandlers) {
          handler(sessionId, payload.value)
        }
        return
      }

      case 'fetchOlder': {
        for (const handler of this.fetchOlderHandlers) {
          handler(sessionId, payload.value)
        }
        return
      }

      case 'previewOptIn': {
        for (const handler of this.previewOptInHandlers) handler(sessionId, payload.value)
        return
      }
      case 'draftReload': {
        for (const handler of this.draftReloadHandlers) handler(sessionId, payload.value)
        return
      }
      case 'draftPromote': {
        for (const handler of this.draftPromoteHandlers) handler(sessionId, payload.value)
        return
      }
      case 'draftDiscard': {
        for (const handler of this.draftDiscardHandlers) handler(sessionId, payload.value)
        return
      }
      case 'draftTurnCancel': {
        for (const handler of this.draftTurnCancelHandlers) handler(sessionId, payload.value)
        return
      }

      case undefined:
        // Empty envelope (decode succeeded but no payload variant matched) —
        // silently drop.
        return

      default:
        // Exhaustiveness: payload.case is a closed union; this is unreachable.
        return
    }
  }

  private handleBinaryFrame(sessionId: string, data: Buffer): void {
    const parsed = parseBinaryFrame(data)
    if (!parsed) return

    // Zero-copy view cast to Buffer (Node APIs prefer Buffer over Uint8Array).
    const payload = Buffer.from(
      parsed.payload.buffer,
      parsed.payload.byteOffset,
      parsed.payload.byteLength,
    )

    switch (parsed.frameType) {
      case BinaryFrameType.AUDIO: {
        let header: AudioChunkHeader
        try {
          header = decodeAudioHeader(parsed.headerBytes)
        } catch {
          console.warn('[ws] dropping audio frame: malformed AudioChunkHeader')
          return
        }
        // Only PCM16 @ 16 kHz with a set scope is supported. Drop others with
        // a warn so a single bad frame can't kill the session.
        if (header.format !== AudioFormat.PCM16 || header.sampleRate !== 16000 || !header.scope) {
          console.warn('[ws] dropping audio frame with unsupported header', {
            format: header.format,
            sampleRate: header.sampleRate,
            scope: header.scope,
          })
          return
        }
        for (const handler of this.audioInputHandlers) handler(sessionId, header, payload)
        return
      }
    }
  }

  // -----------------------------------------------------------------------
  // Send path (no durability, no replay)
  // -----------------------------------------------------------------------

  /** Best-effort send to a live socket. Closed sockets drop silently. */
  private sendToSession(session: SessionState, message: ServerMessage): void {
    if (session.ws.readyState !== WebSocket.OPEN) return
    const payload = this.encodeFrame(message)
    if (payload) this.rawSend(session, payload)
  }

  /**
   * Encode a ServerMessage to wire bytes, NEVER throwing. A malformed message
   * (e.g. a draft face with an invalid enum that only fails at serialization)
   * must drop that frame and log, not crash the server. Returns null on
   * failure; callers skip the send.
   */
  private encodeFrame(message: ServerMessage): Uint8Array | null {
    try {
      return toBinary(ServerMessageSchema, message)
    } catch (err) {
      const kind = message.payload?.case ?? 'unknown'
      console.error(
        `[ws] dropped un-encodable ${kind} frame: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  private rawSend(session: SessionState, payload: string | Uint8Array | Buffer): void {
    try {
      session.ws.send(payload)
    } catch {
      // Socket died mid-send; close handler tears down state.
      return
    }
    // Backpressure: pause disposable broadcasts until the outbound buffer drains.
    const buffered = session.ws.bufferedAmount
    if (!session.backpressurePaused && buffered > this.backpressureThresholdBytes) {
      session.backpressurePaused = true
    } else if (session.backpressurePaused && buffered < this.backpressureThresholdBytes / 2) {
      session.backpressurePaused = false
    }
  }

  // -----------------------------------------------------------------------
  // Disconnect (no grace, no TTL)
  // -----------------------------------------------------------------------

  /** Tear down a session: clear rate-limit state, close socket, remove from registry, notify handlers. Idempotent. */
  private destroySession(session: SessionState, _reason: string): void {
    if (!this.sessions.has(session.sessionId)) return

    session.turnTimestamps.length = 0

    if (
      session.ws.readyState === WebSocket.OPEN ||
      session.ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        session.ws.close(1001, 'session-closed')
      } catch {
        /* ignore */
      }
    }

    this.sessions.delete(session.sessionId)

    for (const handler of this.disconnectHandlers) {
      handler(session.sessionId)
    }
  }

  // -----------------------------------------------------------------------
  // Rate limiting helpers
  // -----------------------------------------------------------------------

  private consumeBinaryFrameBudget(session: SessionState): boolean {
    const nowMs = this.now()
    if (nowMs - session.binaryFrameBucket.startMs >= 1000) {
      session.binaryFrameBucket.startMs = nowMs
      session.binaryFrameBucket.count = 0
    }
    if (session.binaryFrameBucket.count >= this.maxBinaryFramesPerSec) {
      return false
    }
    session.binaryFrameBucket.count += 1
    return true
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Subprotocol selection callback for the `ws` library. Accepts only
 * `moumantai.v1.proto`. Clients that omit it get a 4002 close after
 * handshake when their first frame fails to decode.
 */
function handleSubprotocol(protocols: Set<string>, _request: IncomingMessage): string | false {
  if (protocols.has('moumantai.v1.proto')) return 'moumantai.v1.proto'
  return false
}

function isValidClientHello(msg: ClientHello): boolean {
  if (msg.deviceClass === DeviceClass.UNSPECIFIED) return false
  if (!msg.deviceProfile) return false
  if (msg.deviceClass < DeviceClass.PHONE || msg.deviceClass > DeviceClass.HMI_PANEL) return false
  return true
}

/**
 * Map screen width (dp) to SizeClass.
 *   COMPACT:  ≤ 240 (watch 192, iot-small 240)
 *   EXPANDED: > 240 (phone 390+, tablet, desktop, hmi-panel 320)
 *
 * M3-WindowSizeClass-style reflow within EXPANDED is a renderer concern.
 */
export function classifyWidth(width: number): SizeClass {
  return width <= 240 ? SizeClass.COMPACT : SizeClass.EXPANDED
}

/**
 * Extract nav-intent fields from a ClientHello for connect handlers.
 * Returns undefined if no nav fields were provided (callsites remain branch-free).
 */
function extractNavIntent(hello: ClientHello): HelloNavIntent | undefined {
  if (hello.currentAppId === undefined && hello.currentFaceId === undefined) {
    return undefined
  }
  const nav: HelloNavIntent = {}
  if (hello.currentAppId !== undefined) nav.currentAppId = hello.currentAppId
  if (hello.currentFaceId !== undefined) nav.currentFaceId = hello.currentFaceId
  return nav
}
