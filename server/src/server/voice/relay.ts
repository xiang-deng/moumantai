/**
 * Voice relay pipeline.
 *
 * Buffers audio chunks, delegates STT/TTS to an AudioService, and emits
 * typed events for the caller to forward. Knows nothing about apps, surfaces,
 * or routing. `voiceKey` is the caller-supplied WS sessionId (opaque to the
 * relay); unrelated to the wire-protocol `scope` field.
 */

import type { AudioService, AudioCodec } from './audio-service.js'
import { VoiceStateValue } from '@moumantai/protocol/generated/moumantai/v1'
import type { ServerMessage } from '@moumantai/protocol/generated/moumantai/v1'
import { msgVoiceState } from '../transport/messages.js'

// ---------------------------------------------------------------------------
// Event types returned to the caller
// ---------------------------------------------------------------------------

export type VoiceRelayEvent =
  | { type: 'voiceState'; state: VoiceStateValue }
  | { type: 'audioChunk'; data: Buffer; format: string; sampleRate: number; final: boolean }
  | { type: 'transcript'; text: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum size (bytes) of a single outbound audio chunk. */
const TTS_CHUNK_SIZE = 4096

/** Max buffered inbound audio per session. 30 s @ 16 kHz PCM16 mono ≈ 960 000 bytes. */
const DEFAULT_MAX_AUDIO_BYTES = 960_000

/** Listening-idle TTL: drops buffered audio and resets to idle after this many ms without a chunk. Guards against stuck mics. */
const LISTENING_IDLE_TTL_MS = 30_000

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Minimal surface the relay needs from the client manager — just voice-state get/set. */
export interface VoiceRelayClientStore {
  setVoiceState(sessionId: string, value: VoiceStateValue): void
  getVoiceState(sessionId: string): VoiceStateValue | undefined
}

/** Send a typed `ServerMessage` to a specific client (wraps WsServer.send). */
export type VoiceRelaySend = (sessionId: string, message: ServerMessage) => void

// ---------------------------------------------------------------------------
// VoiceRelay
// ---------------------------------------------------------------------------

export interface VoiceRelayOptions {
  /** Max total buffered bytes per session during one utterance. */
  maxAudioBytes?: number
  /** Override the listening-idle TTL (ms). Primarily for tests. */
  listeningIdleTtlMs?: number
  /** Per-client voice-state store. Required: mis-wired production would silently no-op. */
  clientStore: VoiceRelayClientStore
  /** Callback used to push `voiceState: idle` wire messages on TTL expiry. */
  send: VoiceRelaySend
}

export class VoiceRelay {
  private audio: AudioService
  private audioBuffers = new Map<string, Buffer[]>()
  private audioBufferSizes = new Map<string, number>()
  private currentState = new Map<string, VoiceStateValue>()
  /**
   * Scope the current utterance buffer was started on. Set on the first chunk;
   * cleared when the buffer clears. A mid-utterance scope change would produce
   * a cross-scope transcript mashup — those chunks are rejected and the client
   * is reset to idle.
   */
  private bufferStartScope = new Map<string, string>()
  /** Set of voice keys that have an active synthesis in progress. */
  private activeSynthesis = new Set<string>()
  /**
   * Per-session listening-idle timers (keyed by voiceKey = sessionId).
   * voiceKey is stored in the entry so late-firing callbacks can guard
   * against state transitions that happened after the timer was set.
   */
  private idleTimers = new Map<string, { timer: NodeJS.Timeout; voiceKey: string }>()
  private maxAudioBytes: number
  private listeningIdleTtlMs: number
  private clientStore: VoiceRelayClientStore
  private send: VoiceRelaySend

  constructor(audio: AudioService, options: VoiceRelayOptions) {
    this.audio = audio
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES
    this.listeningIdleTtlMs = options.listeningIdleTtlMs ?? LISTENING_IDLE_TTL_MS
    this.clientStore = options.clientStore
    this.send = options.send
  }

  /**
   * Handle an incoming audio chunk from a client.
   *
   * Buffers chunks until `final === true`, then transcribes the complete
   * audio buffer and returns events the caller should relay to the client.
   */
  async handleAudioInput(opts: {
    voiceKey: string
    scope: string
    data: Buffer
    format: string
    sampleRate: number
    final: boolean
  }): Promise<VoiceRelayEvent[]> {
    const { voiceKey, scope, data, format, sampleRate, final: isFinal } = opts

    // Cross-scope guard: a buffer started on scope A cannot safely receive
    // a chunk declared as scope B — the transcript would mix intent across
    // surfaces. Discard, reset to idle, and return an error.
    const existingScope = this.bufferStartScope.get(voiceKey)
    if (existingScope !== undefined && existingScope !== scope) {
      this.clearBuffer(voiceKey)
      this.clearIdleTimer(voiceKey)
      this.setState(voiceKey, VoiceStateValue.IDLE)
      return [
        {
          type: 'error',
          message: `voice_scope_changed: utterance started on '${existingScope}' but chunk arrived on '${scope}'; please restart`,
        },
        { type: 'voiceState', state: VoiceStateValue.IDLE },
      ]
    }

    // Audio arriving while SPEAKING is an interruption.
    if (this.currentState.get(voiceKey) === VoiceStateValue.SPEAKING) {
      const interruptEvents = this.handleInterruption(voiceKey)
      if (!this.appendChunk(voiceKey, data)) {
        return [...interruptEvents, ...this.overflowEvents(voiceKey)]
      }
      this.bufferStartScope.set(voiceKey, scope)
      this.armIdleTimer(voiceKey)
      if (isFinal) {
        const processEvents = await this.processAudio(voiceKey, {
          format: format as AudioCodec['format'],
          sampleRate,
        })
        return [...interruptEvents, ...processEvents]
      }
      return interruptEvents
    }

    // Normal buffering with per-session size cap.
    if (!this.appendChunk(voiceKey, data)) {
      return this.overflowEvents(voiceKey)
    }

    if (existingScope === undefined) {
      this.bufferStartScope.set(voiceKey, scope)
    }

    this.armIdleTimer(voiceKey)

    if (!isFinal) {
      return []
    }

    // Final chunk: process the complete buffer.
    return this.processAudio(voiceKey, {
      format: format as AudioCodec['format'],
      sampleRate,
    })
  }

  private async processAudio(voiceKey: string, codec: AudioCodec): Promise<VoiceRelayEvent[]> {
    const events: VoiceRelayEvent[] = []

    this.clearIdleTimer(voiceKey)

    // Transition to thinking.
    this.setState(voiceKey, VoiceStateValue.THINKING)
    events.push({ type: 'voiceState', state: VoiceStateValue.THINKING })

    // Concatenate buffered chunks.
    const chunks = this.audioBuffers.get(voiceKey) ?? []
    const fullBuffer = Buffer.concat(chunks)
    this.clearBuffer(voiceKey)

    try {
      const durationMs = Math.round(fullBuffer.length / 2 / (codec.sampleRate / 1000))
      console.log(
        `[voice] transcribing ${fullBuffer.length}B (${durationMs}ms @ ${codec.sampleRate}Hz, ${chunks.length} chunks)`,
      )
      const text = await this.audio.transcribe(fullBuffer, codec)
      events.push({ type: 'transcript', text })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transcription failed'
      events.push({ type: 'error', message })
      this.setState(voiceKey, VoiceStateValue.IDLE)
      events.push({ type: 'voiceState', state: VoiceStateValue.IDLE })
    }

    return events
  }

  /**
   * Synthesize text to speech and return audio chunk events.
   *
   * Called by the server after the LLM (or handler) produces a text response.
   */
  async synthesizeResponse(text: string, voiceKey: string): Promise<VoiceRelayEvent[]> {
    const events: VoiceRelayEvent[] = []

    this.setState(voiceKey, VoiceStateValue.SPEAKING)
    this.activeSynthesis.add(voiceKey)
    events.push({ type: 'voiceState', state: VoiceStateValue.SPEAKING })

    try {
      const audioBuffer = await this.audio.synthesize(text)

      // Bail out if synthesis was interrupted while awaiting.
      if (!this.activeSynthesis.has(voiceKey)) {
        return events
      }

      const totalLength = audioBuffer.length
      let offset = 0
      while (offset < totalLength) {
        if (!this.activeSynthesis.has(voiceKey)) {
          return events
        }

        const end = Math.min(offset + TTS_CHUNK_SIZE, totalLength)
        const isFinal = end >= totalLength
        events.push({
          type: 'audioChunk',
          data: audioBuffer.subarray(offset, end),
          format: 'pcm16',
          sampleRate: 16000,
          final: isFinal,
        })
        offset = end
      }

      this.activeSynthesis.delete(voiceKey)
      this.setState(voiceKey, VoiceStateValue.IDLE)
      events.push({ type: 'voiceState', state: VoiceStateValue.IDLE })
    } catch (err: unknown) {
      this.activeSynthesis.delete(voiceKey)
      const message = err instanceof Error ? err.message : 'Speech synthesis failed'
      events.push({ type: 'error', message })
      this.setState(voiceKey, VoiceStateValue.IDLE)
      events.push({ type: 'voiceState', state: VoiceStateValue.IDLE })
    }

    return events
  }

  /**
   * Handle an interruption: the user started talking while TTS was playing.
   *
   * Cancels any pending synthesis and transitions to listening.
   */
  handleInterruption(voiceKey: string): VoiceRelayEvent[] {
    this.activeSynthesis.delete(voiceKey)
    this.clearBuffer(voiceKey)
    this.setState(voiceKey, VoiceStateValue.LISTENING)
    return [{ type: 'voiceState', state: VoiceStateValue.LISTENING }]
  }

  /**
   * Get the current voice state for a session.
   */
  getState(voiceKey: string): VoiceStateValue {
    return this.currentState.get(voiceKey) ?? VoiceStateValue.IDLE
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getBuffer(voiceKey: string): Buffer[] {
    let buf = this.audioBuffers.get(voiceKey)
    if (!buf) {
      buf = []
      this.audioBuffers.set(voiceKey, buf)
    }
    return buf
  }

  /** Append a chunk, enforcing the per-session byte cap. Returns false on overflow. */
  private appendChunk(voiceKey: string, data: Buffer): boolean {
    const current = this.audioBufferSizes.get(voiceKey) ?? 0
    const next = current + data.length
    if (next > this.maxAudioBytes) {
      this.clearBuffer(voiceKey)
      return false
    }
    this.getBuffer(voiceKey).push(data)
    this.audioBufferSizes.set(voiceKey, next)
    return true
  }

  private overflowEvents(voiceKey: string): VoiceRelayEvent[] {
    this.setState(voiceKey, VoiceStateValue.IDLE)
    this.clearIdleTimer(voiceKey)
    return [
      {
        type: 'error',
        message: `audio_overflow: per-session buffer exceeded ${this.maxAudioBytes} bytes`,
      },
      { type: 'voiceState', state: VoiceStateValue.IDLE },
    ]
  }

  private clearBuffer(voiceKey: string): void {
    this.audioBuffers.delete(voiceKey)
    this.audioBufferSizes.delete(voiceKey)
    this.bufferStartScope.delete(voiceKey)
  }

  private setState(voiceKey: string, state: VoiceStateValue): void {
    this.currentState.set(voiceKey, state)
  }

  /**
   * (Re)arm the listening-idle TTL. Arming also marks the session as
   * `listening` in local state. The late-fire guard in `onIdleTimeout` uses
   * that to detect state changes (e.g. transition to `thinking`).
   */
  private armIdleTimer(voiceKey: string): void {
    const existing = this.idleTimers.get(voiceKey)
    if (existing) clearTimeout(existing.timer)
    this.currentState.set(voiceKey, VoiceStateValue.LISTENING)
    const timer = setTimeout(() => this.onIdleTimeout(voiceKey), this.listeningIdleTtlMs)
    if (typeof timer.unref === 'function') timer.unref() // don't keep the process alive
    this.idleTimers.set(voiceKey, { timer, voiceKey })
  }

  /** Cancel the idle TTL for a session. */
  private clearIdleTimer(voiceKey: string): void {
    const entry = this.idleTimers.get(voiceKey)
    if (entry) {
      clearTimeout(entry.timer)
      this.idleTimers.delete(voiceKey)
    }
  }

  /**
   * Fires when no audio arrives for `LISTENING_IDLE_TTL_MS`. Drops buffers,
   * resets to idle, notifies the transport.
   *
   * Guards against late-firing: if the map entry is gone or the client has
   * left `listening` (e.g. transitioned to `thinking`), returns without
   * writing state — clobbering back to idle would corrupt the active turn.
   */
  private onIdleTimeout(voiceKey: string): void {
    const entry = this.idleTimers.get(voiceKey)
    if (!entry) return
    if (this.currentState.get(voiceKey) !== VoiceStateValue.LISTENING) return

    this.idleTimers.delete(voiceKey)
    this.clearBuffer(voiceKey)
    this.currentState.set(voiceKey, VoiceStateValue.IDLE)
    this.clientStore.setVoiceState(voiceKey, VoiceStateValue.IDLE)
    this.send(voiceKey, msgVoiceState({ state: VoiceStateValue.IDLE }))
    console.log(`[voice] listening-idle TTL fired for ${voiceKey}; reset to idle`)
  }

  /**
   * Drop all buffers, state, synthesis, and idle timer for a client.
   * Called from the WS disconnect cascade. Keys are exact-match UUIDs.
   */
  destroyClient(clientId: string): void {
    this.audioBuffers.delete(clientId)
    this.audioBufferSizes.delete(clientId)
    this.bufferStartScope.delete(clientId)
    this.currentState.delete(clientId)
    this.activeSynthesis.delete(clientId)
    const entry = this.idleTimers.get(clientId)
    if (entry) {
      clearTimeout(entry.timer)
      this.idleTimers.delete(clientId)
    }
  }
}
