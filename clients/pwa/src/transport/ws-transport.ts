/**
 * WebSocket client transport (PWA).
 *
 * Same wire format as the Android client: protobuf-es binary,
 * `moumantai.v1.proto` subprotocol, audio frames with a 1-byte type prefix.
 *
 * Default URL: `wss://${window.location.host}` (co-served via Tailscale Serve).
 * Override via `localStorage.moumantai.serverUrl` or `VITE_WS_URL`.
 * Device class: `PHONE`.
 */

import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf'
import {
  AudioFormat,
  BinaryFrameType,
  type AppListMsg,
  type ChatHistoryMsg,
  type ChatMessage,
  type ChatWindowMsg,
  ClientHelloSchema,
  type ClientMessage,
  ClientMessageSchema,
  DeviceClass,
  DeviceProfileSchema,
  DeviceShape,
  type FaceListMsg,
  type FaceUpdateMsg,
  ChatInputSchema,
  ChatKind,
  CloseCode,
  FetchOlderMsgSchema,
  type NavigateMsg,
  ResetConversationMsgSchema,
  type ServerHello,
  type ServerMessage,
  ServerMessageSchema,
  InvokeToolMsgSchema,
  TTSRequestSchema,
  ViewingMsgSchema,
  type VoiceState,
  type ErrorMessage,
  type UiActionEscalated,
  type DraftStateChanged,
  type DraftActionResult,
  type ChatTodosUpdate,
  PreviewOptInRequestSchema,
  DraftReloadRequestSchema,
  DraftPromoteRequestSchema,
  DraftDiscardRequestSchema,
  DraftTurnCancelRequestSchema,
} from '@moumantai/protocol/generated/moumantai/v1'
import type { JsonObject } from '@bufbuild/protobuf'
import {
  audioChunkHeader,
  decodeAudioHeader,
  encodeAudioFrame,
  parseBinaryFrame,
} from '@moumantai/protocol'

const WS_SUBPROTOCOL = 'moumantai.v1.proto'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
// Pairing retry: fixed interval (not backoff) so approval feels near-instant,
// but only while visible and within a bounded burst — prevents a forgotten
// device from polling forever and draining battery.
const PAIRING_RETRY_MS = 4000
const PAIRING_BURST_MS = 120_000 // ~2 min burst, then require explicit retry
const DEVICE_ID_STORAGE_KEY = 'moumantai.deviceId'
const SERVER_URL_STORAGE_KEY = 'moumantai.serverUrl'

/**
 * Resolve the WebSocket URL. Three sources, in priority order:
 *
 *   1. `localStorage.moumantai.serverUrl` — user override set via Settings.
 *      The escape hatch for unusual deployments. Always wins.
 *   2. `VITE_WS_URL` — build-time env var. The committed `.env.development`
 *      file sets this to `ws://localhost:3000` so dev "just works"; production
 *      builds omit it.
 *   3. Same-origin (`wss://<host>` or `ws://<host>`). The intended production
 *      shape: PWA + server co-served by Tailscale Serve or the server's own
 *      static handler.
 *
 * No localhost detection, no port heuristics. If none of the above produces
 * a working URL the connection fails; the UI surfaces the error and the user
 * fixes it via Settings.
 */
export function resolveDefaultServerUrl(): string {
  try {
    const stored = localStorage.getItem(SERVER_URL_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // localStorage may be unavailable; fall through.
  }
  const envUrl = import.meta.env.VITE_WS_URL
  if (envUrl) return envUrl

  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}`
  }
  return ''
}

function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    if (existing && existing.length > 0) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
}

export type SendDroppedKind = 'invokeTool' | 'chatInput' | 'other'
export type AudioFormatLabel = 'pcm16'

interface DeviceProfileInput {
  width: number
  height: number
}

const AUDIO_FORMAT_TO_PROTO: Record<AudioFormatLabel, AudioFormat> = {
  pcm16: AudioFormat.PCM16,
}

export class WebSocketTransport {
  private ws: WebSocket | null = null
  private serverUrl: string
  private chatCallbacks = new Set<(msg: ChatMessage) => void>()
  private chatWindowCallbacks = new Set<(msg: ChatWindowMsg) => void>()
  private chatHistoryCallbacks = new Set<(msg: ChatHistoryMsg) => void>()
  private voiceStateCallbacks = new Set<(msg: VoiceState) => void>()
  private appListCallbacks = new Set<(msg: AppListMsg) => void>()
  private faceListCallbacks = new Set<(msg: FaceListMsg) => void>()
  private faceUpdateCallbacks = new Set<(msg: FaceUpdateMsg) => void>()
  private navigateCallbacks = new Set<(msg: NavigateMsg) => void>()
  private helloOkCallbacks = new Set<(msg: ServerHello) => void>()
  private errorCallbacks = new Set<(msg: ErrorMessage) => void>()
  private uiActionEscalatedCallbacks = new Set<(msg: UiActionEscalated) => void>()
  private draftStateChangedCallbacks = new Set<(msg: DraftStateChanged) => void>()
  private chatTodosUpdateCallbacks = new Set<(msg: ChatTodosUpdate) => void>()
  private sendDroppedCallbacks = new Set<(kind: SendDroppedKind) => void>()
  private closeCallbacks = new Set<() => void>()
  private pairingRequiredCallbacks = new Set<(code: string) => void>()
  private audioChunkCallbacks = new Set<
    (data: ArrayBuffer, sampleRate: number, final: boolean) => void
  >()
  private draftActionPending = new Map<string, (r: DraftActionResult) => void>()
  private sessionId: string | null = null
  private readonly deviceId: string = getOrCreateDeviceId()
  private lastProfile: DeviceProfileInput | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  // True between PAIRING_REQUIRED close and next successful hello.
  private pairingPending = false
  // Wallclock deadline for the active pairing-poll burst; 0 = none running.
  private pairingBurstDeadline = 0
  private pairingExhaustedCallbacks = new Set<() => void>()
  private visibilityHandler: (() => void) | null = null

  /** Short pairing code shown on screen — last 4 hex of the deviceId, uppercased.
   * Mirrors the server's `deviceCode()` so the operator can match it 1:1. */
  get pairingCode(): string {
    return this.deviceId.slice(-4).toUpperCase()
  }

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl ?? resolveDefaultServerUrl()
  }

  connect(profile: DeviceProfileInput): void {
    this.lastProfile = profile
    this.intentionalClose = false
    this.reconnectAttempt = 0
    // Resume pairing poll on foreground return (paused while hidden to save battery).
    if (this.visibilityHandler == null && typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (
          document.visibilityState === 'visible' &&
          this.pairingPending &&
          !this.intentionalClose
        ) {
          this.retryPairing()
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
    // Re-resolve in case serverUrl changed in Settings since construction.
    this.serverUrl = resolveDefaultServerUrl() || this.serverUrl
    this.openSocket()
  }

  /** Explicit "try pairing again" — resets the burst and reconnects immediately.
   * Used by the pairing banner's Retry button and on return-to-foreground. */
  retryPairing(): void {
    if (this.intentionalClose) return
    this.pairingBurstDeadline = Date.now() + PAIRING_BURST_MS
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.ws) this.openSocket()
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.visibilityHandler != null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.sessionId = null
  }

  /**
   * Send a chat input. Optional `imageData`/`imageMimeType` attach an image.
   * `kind` defaults to `'chat'`; pass `'dev'` to route to the edit-agent thread.
   */
  sendChatInput(
    scope: string,
    text: string,
    clientMsgId?: string,
    imageData?: Uint8Array,
    imageMimeType?: string,
    kind?: 'chat' | 'dev',
  ): void {
    const value = create(ChatInputSchema, {
      scope,
      text,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(imageData ? { imageData } : {}),
      ...(imageMimeType ? { imageMimeType } : {}),
      ...(kind === 'dev' ? { kind: ChatKind.DEV } : {}),
    })
    this.sendClientMessage({ payload: { case: 'chatInput', value } })
  }

  sendFetchOlder(scope: string, beforeSeq: bigint, limit: number = 50): void {
    const value = create(FetchOlderMsgSchema, { scope, beforeSeq, limit })
    this.sendClientMessage({ payload: { case: 'fetchOlder', value } })
  }

  sendViewing(scope: string): void {
    const value = create(ViewingMsgSchema, { scope })
    this.sendClientMessage({ payload: { case: 'viewing', value } })
  }

  sendResetConversation(scope: string, kind: 'chat' | 'dev' = 'chat'): void {
    const value = create(ResetConversationMsgSchema, {
      scope,
      // Omit kind for CHAT — proto3 default enum is CHAT.
      ...(kind === 'dev' ? { kind: ChatKind.DEV } : {}),
    })
    this.sendClientMessage({ payload: { case: 'resetConversation', value } })
  }

  sendInvokeTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    sourceFaceId: string,
    clientRequestId: string,
    escalationPrompt?: string,
  ): void {
    const value = create(InvokeToolMsgSchema, {
      toolName,
      args: args as JsonObject | undefined,
      sourceFaceId,
      clientRequestId,
      ...(escalationPrompt !== undefined ? { escalationPrompt } : {}),
    })
    this.sendClientMessage({ payload: { case: 'invokeTool', value } })
  }

  sendAudioInput(
    data: ArrayBuffer,
    format: AudioFormatLabel,
    sampleRate: number,
    final: boolean,
    scope: string,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const frame = encodeAudioFrame(
      audioChunkHeader({ scope, format: AUDIO_FORMAT_TO_PROTO[format], sampleRate, final }),
      new Uint8Array(data),
    )
    this.ws.send(frame)
  }

  sendTTSRequest(text: string): void {
    const value = create(TTSRequestSchema, { text })
    this.sendClientMessage({ payload: { case: 'ttsRequest', value } })
  }

  private sendDraftAction(
    draftId: string,
    payload: MessageInitShape<typeof ClientMessageSchema>['payload'],
  ): Promise<DraftActionResult> {
    return new Promise<DraftActionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.draftActionPending.delete(draftId)
        resolve({
          $typeName: 'moumantai.v1.DraftActionResult',
          draftId,
          ok: false,
          error: 'timeout',
        })
      }, 15000)
      this.draftActionPending.set(draftId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.sendClientMessage({ payload })
    })
  }

  sendPreviewOptIn(draftId: string, optIn: boolean): Promise<DraftActionResult> {
    const value = create(PreviewOptInRequestSchema, { draftId, optIn })
    return this.sendDraftAction(draftId, { case: 'previewOptIn', value })
  }

  sendDraftReload(draftId: string): Promise<DraftActionResult> {
    const value = create(DraftReloadRequestSchema, { draftId })
    return this.sendDraftAction(draftId, { case: 'draftReload', value })
  }

  sendDraftPromote(draftId: string): Promise<DraftActionResult> {
    const value = create(DraftPromoteRequestSchema, { draftId })
    return this.sendDraftAction(draftId, { case: 'draftPromote', value })
  }

  sendDraftDiscard(draftId: string): Promise<DraftActionResult> {
    const value = create(DraftDiscardRequestSchema, { draftId })
    return this.sendDraftAction(draftId, { case: 'draftDiscard', value })
  }

  sendDraftTurnCancel(draftId: string): Promise<DraftActionResult> {
    const value = create(DraftTurnCancelRequestSchema, { draftId })
    return this.sendDraftAction(draftId, { case: 'draftTurnCancel', value })
  }

  onChatMessage(callback: (msg: ChatMessage) => void): () => void {
    this.chatCallbacks.add(callback)
    return () => {
      this.chatCallbacks.delete(callback)
    }
  }
  onChatWindow(callback: (msg: ChatWindowMsg) => void): () => void {
    this.chatWindowCallbacks.add(callback)
    return () => {
      this.chatWindowCallbacks.delete(callback)
    }
  }
  onChatHistory(callback: (msg: ChatHistoryMsg) => void): () => void {
    this.chatHistoryCallbacks.add(callback)
    return () => {
      this.chatHistoryCallbacks.delete(callback)
    }
  }
  onVoiceState(callback: (msg: VoiceState) => void): () => void {
    this.voiceStateCallbacks.add(callback)
    return () => {
      this.voiceStateCallbacks.delete(callback)
    }
  }
  onAudioChunk(
    callback: (data: ArrayBuffer, sampleRate: number, final: boolean) => void,
  ): () => void {
    this.audioChunkCallbacks.add(callback)
    return () => {
      this.audioChunkCallbacks.delete(callback)
    }
  }
  onAppList(callback: (msg: AppListMsg) => void): () => void {
    this.appListCallbacks.add(callback)
    return () => {
      this.appListCallbacks.delete(callback)
    }
  }
  onFaceList(callback: (msg: FaceListMsg) => void): () => void {
    this.faceListCallbacks.add(callback)
    return () => {
      this.faceListCallbacks.delete(callback)
    }
  }
  onFaceUpdate(callback: (msg: FaceUpdateMsg) => void): () => void {
    this.faceUpdateCallbacks.add(callback)
    return () => {
      this.faceUpdateCallbacks.delete(callback)
    }
  }
  onNavigate(callback: (msg: NavigateMsg) => void): () => void {
    this.navigateCallbacks.add(callback)
    return () => {
      this.navigateCallbacks.delete(callback)
    }
  }
  onHelloOk(callback: (msg: ServerHello) => void): () => void {
    this.helloOkCallbacks.add(callback)
    return () => {
      this.helloOkCallbacks.delete(callback)
    }
  }
  onError(callback: (msg: ErrorMessage) => void): () => void {
    this.errorCallbacks.add(callback)
    return () => {
      this.errorCallbacks.delete(callback)
    }
  }
  onUiActionEscalated(callback: (msg: UiActionEscalated) => void): () => void {
    this.uiActionEscalatedCallbacks.add(callback)
    return () => {
      this.uiActionEscalatedCallbacks.delete(callback)
    }
  }
  onDraftStateChanged(callback: (msg: DraftStateChanged) => void): () => void {
    this.draftStateChangedCallbacks.add(callback)
    return () => {
      this.draftStateChangedCallbacks.delete(callback)
    }
  }
  onChatTodosUpdate(callback: (msg: ChatTodosUpdate) => void): () => void {
    this.chatTodosUpdateCallbacks.add(callback)
    return () => {
      this.chatTodosUpdateCallbacks.delete(callback)
    }
  }
  onSendDropped(callback: (kind: SendDroppedKind) => void): () => void {
    this.sendDroppedCallbacks.add(callback)
    return () => {
      this.sendDroppedCallbacks.delete(callback)
    }
  }

  /**
   * Fires every time the underlying WebSocket closes — clean shutdown,
   * server-side reject, network drop. Useful for surfacing disconnect state
   * to the UI; reconnect attempts happen automatically in the background.
   */
  onClose(callback: () => void): () => void {
    this.closeCallbacks.add(callback)
    return () => {
      this.closeCallbacks.delete(callback)
    }
  }

  /**
   * Fired when the server rejects this device with `PAIRING_REQUIRED` (4008).
   * The callback receives the short pairing code to display. The transport keeps
   * retrying on a short interval; a subsequent `onHelloOk` means approval landed.
   */
  onPairingRequired(callback: (code: string) => void): () => void {
    this.pairingRequiredCallbacks.add(callback)
    return () => {
      this.pairingRequiredCallbacks.delete(callback)
    }
  }

  /**
   * Fired when the foreground polling burst elapses without approval — the UI
   * should stop implying "connecting…" and offer an explicit Retry (which calls
   * `retryPairing()`). Polling also auto-resumes if the page returns to front.
   */
  onPairingExhausted(callback: () => void): () => void {
    this.pairingExhaustedCallbacks.add(callback)
    return () => {
      this.pairingExhaustedCallbacks.delete(callback)
    }
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    // Validate URL scheme before construction: `new WebSocket(badUrl)` throws
    // synchronously and bubbles to React's error overlay, blocking Settings.
    if (!/^wss?:\/\//i.test(this.serverUrl)) {
      console.warn(
        `[ws-transport] Invalid server URL "${this.serverUrl}" — must start with ws:// or wss://. ` +
          `Open Settings to fix.`,
      )
      this.intentionalClose = true // suppress reconnect loop
      for (const cb of this.closeCallbacks) cb()
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(this.serverUrl, [WS_SUBPROTOCOL])
    } catch (err) {
      console.warn('[ws-transport] WebSocket construction failed:', err)
      this.intentionalClose = true
      for (const cb of this.closeCallbacks) cb()
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.sendClientHello()
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryFrame(event.data)
      }
    }

    ws.onclose = (event) => {
      this.ws = null
      // PAIRING_REQUIRED (4008): not a fault — start/continue polling.
      // Any other close → normal disconnect path.
      const nowPairing = event.code === CloseCode.PAIRING_REQUIRED
      // Start a fresh burst on the first 4008 of a pending streak.
      if (nowPairing && !this.pairingPending)
        this.pairingBurstDeadline = Date.now() + PAIRING_BURST_MS
      this.pairingPending = nowPairing
      if (this.pairingPending) {
        for (const cb of this.pairingRequiredCallbacks) cb(this.pairingCode)
      } else {
        for (const cb of this.closeCallbacks) cb()
      }
      if (!this.intentionalClose) this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose fires after onerror; reconnect logic lives there.
    }
  }

  private sendClientHello(): void {
    const profile = this.lastProfile ?? { width: 390, height: 844 }
    const init: MessageInitShape<typeof ClientHelloSchema> = {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: create(DeviceProfileSchema, {
        width: profile.width,
        height: profile.height,
        shape: DeviceShape.RECT,
      }),
      deviceId: this.deviceId,
    }
    const hello = create(ClientHelloSchema, init)
    this.sendClientMessage({ payload: { case: 'hello', value: hello } })
  }

  private dispatchMessage(msg: ServerMessage): void {
    const variant = msg.payload
    if (variant.case === undefined) return

    switch (variant.case) {
      case 'helloOk':
        this.handleHelloOk(variant.value)
        return
      case 'chat':
        for (const cb of this.chatCallbacks) cb(variant.value)
        return
      case 'chatWindow':
        for (const cb of this.chatWindowCallbacks) cb(variant.value)
        return
      case 'chatHistory':
        for (const cb of this.chatHistoryCallbacks) cb(variant.value)
        return
      case 'voiceState':
        for (const cb of this.voiceStateCallbacks) cb(variant.value)
        return
      case 'appList':
        for (const cb of this.appListCallbacks) cb(variant.value)
        return
      case 'faceList':
        for (const cb of this.faceListCallbacks) cb(variant.value)
        return
      case 'faceUpdate':
        for (const cb of this.faceUpdateCallbacks) cb(variant.value)
        return
      case 'navigate':
        for (const cb of this.navigateCallbacks) cb(variant.value)
        return
      case 'error':
        for (const cb of this.errorCallbacks) cb(variant.value)
        return
      case 'uiActionEscalated':
        for (const cb of this.uiActionEscalatedCallbacks) cb(variant.value)
        return
      case 'draftStateChanged':
        for (const cb of this.draftStateChangedCallbacks) cb(variant.value)
        return
      case 'draftActionResult': {
        const resolver = this.draftActionPending.get(variant.value.draftId)
        if (resolver) {
          this.draftActionPending.delete(variant.value.draftId)
          resolver(variant.value)
        }
        return
      }
      case 'chatTodosUpdate':
        for (const cb of this.chatTodosUpdateCallbacks) cb(variant.value)
        return
      default:
        console.warn('Unknown ServerMessage payload variant:', variant.case)
        return
    }
  }

  private handleHelloOk(msg: ServerHello): void {
    this.sessionId = msg.sessionId || null
    this.pairingPending = false
    this.pairingBurstDeadline = 0
    for (const cb of this.helloOkCallbacks) cb(msg)
  }

  private handleBinaryFrame(data: ArrayBuffer): void {
    if (data.byteLength === 0) return

    const firstByte = new Uint8Array(data, 0, 1)[0]
    if (firstByte === BinaryFrameType.AUDIO) {
      this.handleAudioFrame(data)
      return
    }
    if (firstByte === BinaryFrameType.IMAGE) return

    let decoded: ServerMessage
    try {
      decoded = fromBinary(ServerMessageSchema, new Uint8Array(data))
    } catch {
      return
    }
    this.dispatchMessage(decoded)
  }

  private handleAudioFrame(data: ArrayBuffer): void {
    const parsed = parseBinaryFrame(new Uint8Array(data))
    if (!parsed) return

    let header
    try {
      header = decodeAudioHeader(parsed.headerBytes)
    } catch {
      return
    }

    const payload = parsed.payload.slice().buffer
    for (const cb of this.audioChunkCallbacks) {
      cb(payload, header.sampleRate, header.final)
    }
  }

  private sendClientMessage(init: MessageInitShape<typeof ClientMessageSchema>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const kase = init.payload?.case
      const kind: SendDroppedKind = kase === 'invokeTool' || kase === 'chatInput' ? kase : 'other'
      for (const cb of this.sendDroppedCallbacks) cb(kind)
      return
    }
    const msg = create(ClientMessageSchema, init)
    const bytes = toBinary(ClientMessageSchema, msg)
    this.ws.send(bytes)
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.lastProfile) return

    if (this.pairingPending) {
      // Pause while hidden (battery); visibilitychange resumes on foreground return.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      // Burst elapsed → show "Retry" instead of auto-polling.
      if (Date.now() > this.pairingBurstDeadline) {
        for (const cb of this.pairingExhaustedCallbacks) cb()
        return
      }
    }

    // Pending approval: fixed interval (no backoff growth) for prompt pickup.
    const delay = this.pairingPending
      ? PAIRING_RETRY_MS
      : Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS)
    if (!this.pairingPending) this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose && this.lastProfile) this.openSocket()
    }, delay)
  }
}

export type { ClientMessage }
