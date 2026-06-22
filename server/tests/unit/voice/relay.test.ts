/**
 * Tests for VoiceRelay -- the voice pipeline that buffers audio, delegates
 * STT/TTS to the AudioService, and emits relay events.
 */

import { VoiceStateValue } from '@moumantai/protocol/generated/moumantai/v1'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VoiceRelay, type VoiceRelayEvent } from '../../../src/server/voice/relay.js'
import type { AudioService } from '../../../src/server/voice/audio-service.js'
import { msgVoiceState } from '../../../src/server/transport/messages.js'

// ---------------------------------------------------------------------------
// Mock AudioService
// ---------------------------------------------------------------------------

function createMockAudio(overrides?: Partial<AudioService>): AudioService {
  return {
    transcribe: vi.fn().mockResolvedValue('hello world'),
    synthesize: vi.fn().mockResolvedValue(Buffer.alloc(8192, 0x42)),
    ...overrides,
  }
}

/**
 * Minimal stubs for the required collaborators. Tests that care about
 * TTL-driven state writes construct their own; tests that don't use the
 * TTL path still need these to satisfy the required options.
 */
function createStubDeps() {
  return {
    clientStore: { getVoiceState: vi.fn(), setVoiceState: vi.fn() },
    send: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function voiceStates(events: VoiceRelayEvent[]): VoiceStateValue[] {
  return events
    .filter((e): e is Extract<VoiceRelayEvent, { type: 'voiceState' }> => e.type === 'voiceState')
    .map((e) => e.state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceRelay', () => {
  let audio: AudioService
  let relay: VoiceRelay

  beforeEach(() => {
    audio = createMockAudio()
    relay = new VoiceRelay(audio, createStubDeps())
  })

  describe('audio buffer cap', () => {
    it('rejects overflow with audio_overflow error and resets to idle', async () => {
      // Tight cap for the test — 1 KB.
      const cappedRelay = new VoiceRelay(audio, { ...createStubDeps(), maxAudioBytes: 1024 })
      const bigChunk = Buffer.alloc(2048, 0x42) // already exceeds the cap

      const events = await cappedRelay.handleAudioInput({
        voiceKey: 's1',
        scope: 'home',
        data: bigChunk,
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      expect(events.find((e) => e.type === 'error')).toBeDefined()
      const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string }
      expect(err.message).toMatch(/audio_overflow/)
      // Must transition back to idle so the client UI doesn't hang.
      expect(voiceStates(events)).toContain(VoiceStateValue.IDLE)
      // STT was not called.
      expect(audio.transcribe).not.toHaveBeenCalled()
    })

    it('clears the per-session buffer after overflow so a fresh utterance works', async () => {
      const cappedRelay = new VoiceRelay(audio, { ...createStubDeps(), maxAudioBytes: 100 })
      await cappedRelay.handleAudioInput({
        voiceKey: 's1',
        scope: 'home',
        data: Buffer.alloc(200),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      // Subsequent small chunk should behave as a fresh utterance.
      const events = await cappedRelay.handleAudioInput({
        voiceKey: 's1',
        scope: 'home',
        data: Buffer.alloc(50),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      // STT should now have been called once on the 50-byte buffer.
      expect(audio.transcribe).toHaveBeenCalledTimes(1)
      expect(voiceStates(events)).toContain(VoiceStateValue.THINKING)
    })
  })

  describe('destroyClient', () => {
    it('drops buffered audio and state for the session', async () => {
      // voiceKey is the plain WS sessionId — no colon-prefix.
      await relay.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1, 2, 3]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      relay.destroyClient('c1')
      // A fresh final chunk starts a new utterance — no stale concat.
      const events = await relay.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([9]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(events.find((e) => e.type === 'transcript')).toBeDefined()
      const buf = (audio.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Buffer
      expect(buf.length).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Buffering
  // -------------------------------------------------------------------------

  describe('audio buffering', () => {
    it('buffers non-final chunks without emitting events', async () => {
      const events = await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.from('chunk1'),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      expect(events).toHaveLength(0)
      expect(audio.transcribe).not.toHaveBeenCalled()
    })

    it('concatenates multiple chunks and transcribes on final', async () => {
      const chunk1 = Buffer.from([1, 2, 3])
      const chunk2 = Buffer.from([4, 5, 6])
      const chunk3 = Buffer.from([7, 8, 9])

      await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: chunk1,
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: chunk2,
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      const events = await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: chunk3,
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })

      // Should have called transcribe with the concatenated buffer.
      expect(audio.transcribe).toHaveBeenCalledOnce()
      const [buf, fmt] = vi.mocked(audio.transcribe).mock.calls[0]!
      expect(Buffer.compare(buf, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(0)
      expect(fmt).toEqual({ format: 'pcm16', sampleRate: 16000 })

      // Should emit: voiceState:thinking, transcript
      expect(voiceStates(events)).toContain(VoiceStateValue.THINKING)
      const transcript = events.find((e) => e.type === 'transcript') as
        | Extract<VoiceRelayEvent, { type: 'transcript' }>
        | undefined
      expect(transcript?.text).toBe('hello world')
    })
  })

  // -------------------------------------------------------------------------
  // Full voice turn
  // -------------------------------------------------------------------------

  describe('full voice turn', () => {
    it('audio in -> transcript out -> synthesize -> audio out', async () => {
      // 1. Send audio in.
      const inputEvents = await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.from('audio data'),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })

      expect(voiceStates(inputEvents)).toContain(VoiceStateValue.THINKING)
      expect(inputEvents.some((e) => e.type === 'transcript')).toBe(true)

      // 2. Synthesize response.
      const synthEvents = await relay.synthesizeResponse('Here are your expenses', 'main')

      // Should get: voiceState:speaking, audioChunk(s), voiceState:idle
      expect(voiceStates(synthEvents)).toContain(VoiceStateValue.SPEAKING)
      expect(voiceStates(synthEvents)).toContain(VoiceStateValue.IDLE)
      const audioChunks = synthEvents.filter((e) => e.type === 'audioChunk')
      expect(audioChunks.length).toBeGreaterThan(0)

      // Last audio chunk should have final: true.
      const lastChunk = audioChunks[audioChunks.length - 1]! as Extract<
        VoiceRelayEvent,
        { type: 'audioChunk' }
      >
      expect(lastChunk.final).toBe(true)

      // State should be idle.
      expect(relay.getState('main')).toBe(VoiceStateValue.IDLE)
    })

    it('splits large audio buffers into 4096-byte chunks', async () => {
      // Make the audio service return a 10000-byte buffer.
      vi.mocked(audio.synthesize).mockResolvedValue(Buffer.alloc(10000, 0xaa))

      const events = await relay.synthesizeResponse('long text', 'main')
      const audioChunks = events.filter(
        (e): e is Extract<VoiceRelayEvent, { type: 'audioChunk' }> => e.type === 'audioChunk',
      )

      // 10000 / 4096 = 2 full + 1 partial = 3 chunks.
      expect(audioChunks).toHaveLength(3)
      expect(audioChunks[0]!.data.length).toBe(4096)
      expect(audioChunks[1]!.data.length).toBe(4096)
      expect(audioChunks[2]!.data.length).toBe(10000 - 2 * 4096)
      expect(audioChunks[0]!.final).toBe(false)
      expect(audioChunks[1]!.final).toBe(false)
      expect(audioChunks[2]!.final).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Interruption
  // -------------------------------------------------------------------------

  describe('interruption', () => {
    it('transitions from speaking to listening when audio arrives during speaking', async () => {
      let resolveSynthesize!: (buf: Buffer) => void
      vi.mocked(audio.synthesize).mockImplementation(
        () =>
          new Promise<Buffer>((resolve) => {
            resolveSynthesize = resolve
          }),
      )

      // Start synthesis (don't await -- it will block on our deferred).
      const synthPromise = relay.synthesizeResponse('response', 'main')

      // Yield to let synthesizeResponse reach its await.
      await new Promise((r) => setTimeout(r, 0))
      expect(relay.getState('main')).toBe(VoiceStateValue.SPEAKING)

      // Now send audio input while speaking -- should trigger interruption.
      const events = await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.from('interrupt'),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      expect(voiceStates(events)).toContain(VoiceStateValue.LISTENING)
      expect(relay.getState('main')).toBe(VoiceStateValue.LISTENING)

      // Resolve the deferred synthesize so synthPromise completes.
      resolveSynthesize(Buffer.alloc(8192))
      const synthEvents = await synthPromise

      // After interruption, synthesis should have been cancelled.
      expect(voiceStates(synthEvents)).toContain(VoiceStateValue.SPEAKING)
    })
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('emits error + idle on STT failure', async () => {
      vi.mocked(audio.transcribe).mockRejectedValue(new Error('STT service unavailable'))

      const events = await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.from('audio'),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })

      expect(voiceStates(events)).toContain(VoiceStateValue.THINKING)
      expect(voiceStates(events)).toContain(VoiceStateValue.IDLE)
      const errorEvent = events.find((e) => e.type === 'error') as
        | Extract<VoiceRelayEvent, { type: 'error' }>
        | undefined
      expect(errorEvent?.message).toBe('STT service unavailable')
      expect(relay.getState('main')).toBe(VoiceStateValue.IDLE)
    })

    it('emits error + idle on TTS failure', async () => {
      vi.mocked(audio.synthesize).mockRejectedValue(new Error('TTS service unavailable'))

      const events = await relay.synthesizeResponse('hello', 'main')

      expect(voiceStates(events)).toContain(VoiceStateValue.SPEAKING)
      expect(voiceStates(events)).toContain(VoiceStateValue.IDLE)
      const errorEvent = events.find((e) => e.type === 'error') as
        | Extract<VoiceRelayEvent, { type: 'error' }>
        | undefined
      expect(errorEvent?.message).toBe('TTS service unavailable')
      expect(relay.getState('main')).toBe(VoiceStateValue.IDLE)
    })
  })

  // -------------------------------------------------------------------------
  // Session isolation
  // -------------------------------------------------------------------------

  describe('session isolation', () => {
    it('buffers and states are scoped to voiceKey: interleaved sessions transcribe their own bytes', async () => {
      // Two clients dictate concurrently. Each session's buffer must
      // accumulate independently, and finalising one must not touch the
      // other's state or buffer.
      await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.from([1, 1, 1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      await relay.handleAudioInput({
        voiceKey: 'mini',
        scope: 'home',
        data: Buffer.from([2, 2, 2]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // Finalise main:chat — only its 3 bytes should be transcribed.
      await relay.handleAudioInput({
        voiceKey: 'main',
        scope: 'home',
        data: Buffer.alloc(0),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(audio.transcribe).toHaveBeenCalledOnce()
      expect(
        Buffer.compare(vi.mocked(audio.transcribe).mock.calls[0]![0], Buffer.from([1, 1, 1])),
      ).toBe(0)

      // 'mini' is independent: its state is still its own (not affected
      // by 'main's transition), and its buffer holds its 3 bytes.
      await relay.handleAudioInput({
        voiceKey: 'mini',
        scope: 'home',
        data: Buffer.alloc(0),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(audio.transcribe).toHaveBeenCalledTimes(2)
      expect(
        Buffer.compare(vi.mocked(audio.transcribe).mock.calls[1]![0], Buffer.from([2, 2, 2])),
      ).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Listening-idle TTL (R2 — M9.P1)
  // -------------------------------------------------------------------------

  describe('listening-idle TTL', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('fires after 30 s of no audio: clears buffers, sets idle on clientStore, sends idle to transport', async () => {
      const clientStore = {
        setVoiceState: vi.fn(),
        getVoiceState: vi.fn(),
      }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      // Client c1 enters listening with a buffered non-final chunk.
      // voiceKey === sessionId (plain, no scope suffix).
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1, 2, 3, 4]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // Before the TTL fires, no idle notifications yet.
      expect(send).not.toHaveBeenCalled()
      expect(clientStore.setVoiceState).not.toHaveBeenCalled()

      // Just past 30 s — TTL fires.
      vi.advanceTimersByTime(30_000)

      expect(clientStore.setVoiceState).toHaveBeenCalledWith('c1', VoiceStateValue.IDLE)
      expect(send).toHaveBeenCalledWith('c1', msgVoiceState({ state: VoiceStateValue.IDLE }))
      expect(send).toHaveBeenCalledTimes(1)

      // Buffer is cleared: a fresh final chunk starts a new utterance with
      // only its own bytes (no stale concat of the original 4 bytes).
      const events = await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([9]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(events.find((e) => e.type === 'transcript')).toBeDefined()
      const [buf] = vi.mocked(r['audio'].transcribe).mock.calls[0]!
      expect(buf.length).toBe(1)
    })

    it('each incoming audio frame resets the TTL', async () => {
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      // voiceKey === sessionId (plain, no scope suffix).
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // Advance 20 s, then deliver another chunk.
      vi.advanceTimersByTime(20_000)
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([2]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // Another 20 s (total 40 s, but only 20 s since last chunk) — still
      // inside the window, nothing fires.
      vi.advanceTimersByTime(20_000)
      expect(send).not.toHaveBeenCalled()

      // Another 10 s — now 30 s since the second chunk, TTL fires.
      vi.advanceTimersByTime(10_000)
      expect(send).toHaveBeenCalledWith('c1', msgVoiceState({ state: VoiceStateValue.IDLE }))
    })

    it('only the affected client receives the idle wire message', async () => {
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      // Two clients enter listening. voiceKey === sessionId (plain, no scope suffix).
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      // c2 starts 10 s later, so its TTL fires 10 s after c1's.
      vi.advanceTimersByTime(10_000)
      await r.handleAudioInput({
        voiceKey: 'c2',
        scope: 'home',
        data: Buffer.from([2]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // c1's TTL fires first (at 30 s total).
      vi.advanceTimersByTime(20_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('c1', msgVoiceState({ state: VoiceStateValue.IDLE }))
      expect(clientStore.setVoiceState).toHaveBeenCalledWith('c1', VoiceStateValue.IDLE)
      // c2 was not touched.
      expect(clientStore.setVoiceState).not.toHaveBeenCalledWith('c2', VoiceStateValue.IDLE)

      // Another 10 s — c2's TTL fires.
      vi.advanceTimersByTime(10_000)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenLastCalledWith('c2', msgVoiceState({ state: VoiceStateValue.IDLE }))
    })

    it('final chunk (listening -> thinking) cancels the TTL so it does not fire', async () => {
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([2]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })

      // Well past the TTL — nothing should have fired.
      vi.advanceTimersByTime(60_000)
      expect(send).not.toHaveBeenCalled()
    })

    it('destroyClient cancels a pending TTL', async () => {
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      r.destroyClient('c1')

      vi.advanceTimersByTime(60_000)
      expect(send).not.toHaveBeenCalled()
    })

    // ---- race / stale-closure fixes (review P1 R2) --------------------

    it('late-fire race: if state already left `listening`, the callback does NOT clobber it back to idle', async () => {
      // Scenario: the TTL callback was already enqueued by Node's event loop
      // when `processAudio` started — by the time the callback runs, state
      // is already `thinking`. Without the guard, `onIdleTimeout` would
      // overwrite state to `idle` and send a stale wire message.
      //
      // We simulate that race deterministically by flipping the internal
      // state to `thinking` WITHOUT clearing the timer (the exact window
      // where the timer callback is in-flight but not yet executing). This
      // targets the state-based guard specifically; the map-entry guard is
      // covered by the `destroyClient cancels a pending TTL` and
      // `final chunk (listening -> thinking) cancels the TTL` tests.
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      // Enter `listening` via a non-final chunk.
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      expect(r.getState('c1')).toBe(VoiceStateValue.LISTENING)

      // Simulate the in-flight race: state was flipped to `thinking` by
      // `processAudio` but the TTL timer's clearTimeout hasn't processed
      // yet (the callback is already in the macrotask queue).
      const anyRelay = r as unknown as { currentState: Map<string, VoiceStateValue> }
      anyRelay.currentState.set('c1', VoiceStateValue.THINKING)

      // Advance time to trigger the queued TTL callback.
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()

      // The guard caught the stale fire:
      //   - no `setVoiceState(c1, 'idle')` was written
      //   - no `voiceState: idle` was sent to the wire
      //   - state remains `thinking`, not clobbered back to `idle`
      expect(clientStore.setVoiceState).not.toHaveBeenCalledWith('c1', VoiceStateValue.IDLE)
      expect(send).not.toHaveBeenCalled()
      expect(r.getState('c1')).toBe(VoiceStateValue.THINKING)
    })

    it('voiceKey===sessionId; multiple non-final chunks rearm the single TTL slot', async () => {
      // voiceKey is the WS sessionId (no scope suffix). The idle TTL must
      // rearm on each new chunk and fire exactly once against the sessionId
      // when silence exceeds the window.
      const clientStore = { setVoiceState: vi.fn(), getVoiceState: vi.fn() }
      const send = vi.fn()
      const r = new VoiceRelay(createMockAudio(), {
        clientStore,
        send,
        listeningIdleTtlMs: 30_000,
      })

      // Session sends two non-final chunks on the same scope.
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([1, 2, 3]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      expect(r.getState('c1')).toBe(VoiceStateValue.LISTENING)

      // 5 s later, another chunk on same scope re-arms the TTL.
      vi.advanceTimersByTime(5_000)
      await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([4, 5, 6]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      expect(r.getState('c1')).toBe(VoiceStateValue.LISTENING)

      // Advance past the TTL window from the second chunk (30 s of silence).
      vi.advanceTimersByTime(30_000)

      // TTL fired for sessionId 'c1'; exactly one wire notification.
      expect(r.getState('c1')).toBe(VoiceStateValue.IDLE)
      expect(clientStore.setVoiceState).toHaveBeenCalledTimes(1)
      expect(clientStore.setVoiceState).toHaveBeenCalledWith('c1', VoiceStateValue.IDLE)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('c1', msgVoiceState({ state: VoiceStateValue.IDLE }))

      // Buffer was cleared by the TTL: a fresh final chunk starts from empty.
      const events = await r.handleAudioInput({
        voiceKey: 'c1',
        scope: 'home',
        data: Buffer.from([9]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(events.find((e) => e.type === 'transcript')).toBeDefined()
      const [buf] = vi.mocked(r['audio'].transcribe).mock.calls[0]!
      expect(buf.length).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Cross-scope guard (G5 — plan commit 5)
  // -------------------------------------------------------------------------

  describe('cross-scope guard', () => {
    it('rejects a mid-utterance scope switch: clears buffer, emits error + idle, lets a fresh utterance start clean', async () => {
      // User starts dictating on `home`, navigates to `app:diet-tracker`
      // mid-utterance. The server must NOT concatenate the home-intended
      // chunks with the app-intended chunks; it must discard the buffer,
      // surface an error, and force the client back to idle so the user
      // re-records cleanly.
      const voiceKey = 's1'

      // Two chunks while still on home — these build up in the buffer
      // and anchor `bufferStartScope` to 'home'.
      const homeChunks = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])]
      for (const data of homeChunks) {
        const events = await relay.handleAudioInput({
          voiceKey,
          scope: 'home',
          data,
          format: 'pcm16',
          sampleRate: 16000,
          final: false,
        })
        // Pure buffering — no events for non-final home chunks.
        expect(events).toHaveLength(0)
      }
      expect(relay.getState(voiceKey)).toBe(VoiceStateValue.LISTENING)

      // Mid-utterance scope switch: next chunk arrives declared as `app:diet-tracker`.
      const badEvents = await relay.handleAudioInput({
        voiceKey,
        scope: 'app:diet-tracker',
        data: Buffer.from([7, 8, 9]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })

      // Must surface the scope-change error and go back to idle.
      const err = badEvents.find((e) => e.type === 'error') as
        | Extract<VoiceRelayEvent, { type: 'error' }>
        | undefined
      expect(err).toBeDefined()
      expect(err!.message).toMatch(/voice_scope_changed/)
      expect(voiceStates(badEvents)).toEqual([VoiceStateValue.IDLE])
      expect(relay.getState(voiceKey)).toBe(VoiceStateValue.IDLE)

      // STT must NOT have been invoked — the mixed buffer was discarded.
      expect(audio.transcribe).not.toHaveBeenCalled()

      // Fresh utterance proof: the user restarts on home. The buffer is
      // empty (no stale bytes from either scope), so a single-byte final
      // chunk transcribes exactly 1 byte — not 1+6=7 bytes.
      const freshEvents = await relay.handleAudioInput({
        voiceKey,
        scope: 'home',
        data: Buffer.from([42]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(freshEvents.find((e) => e.type === 'transcript')).toBeDefined()
      expect(audio.transcribe).toHaveBeenCalledTimes(1)
      const [buf] = vi.mocked(audio.transcribe).mock.calls[0]!
      expect(buf.length).toBe(1)
    })

    it('same-scope chunks accumulate normally; the guard does NOT trip on a scope that matches', async () => {
      // Regression guard: the scope check must compare start-scope vs
      // incoming-scope, not "is bufferStartScope set". Two chunks on the
      // same scope followed by a final chunk on the same scope must
      // transcribe the concatenation of all three.
      const voiceKey = 's2'
      const chunks = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]

      await relay.handleAudioInput({
        voiceKey,
        scope: 'app:foo',
        data: chunks[0]!,
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      await relay.handleAudioInput({
        voiceKey,
        scope: 'app:foo',
        data: chunks[1]!,
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      const events = await relay.handleAudioInput({
        voiceKey,
        scope: 'app:foo',
        data: chunks[2]!,
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })

      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      expect(events.find((e) => e.type === 'transcript')).toBeDefined()
      const [buf] = vi.mocked(audio.transcribe).mock.calls[0]!
      expect(Buffer.compare(buf, Buffer.from([1, 2, 3]))).toBe(0)
    })

    it('after a scope-change rejection, a new utterance on the originally-intended scope works too', async () => {
      // Proves the rejection clears `bufferStartScope`, not that the key
      // is permanently stuck on the original scope. User starts on home,
      // trips the guard with an app chunk, then decides to re-record on
      // home — this must work (the new first chunk re-anchors the scope).
      const voiceKey = 's3'

      await relay.handleAudioInput({
        voiceKey,
        scope: 'home',
        data: Buffer.from([1]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      await relay.handleAudioInput({
        voiceKey,
        scope: 'app:bar',
        data: Buffer.from([2]),
        format: 'pcm16',
        sampleRate: 16000,
        final: false,
      })
      // Now restart on home with a complete utterance.
      const events = await relay.handleAudioInput({
        voiceKey,
        scope: 'home',
        data: Buffer.from([9]),
        format: 'pcm16',
        sampleRate: 16000,
        final: true,
      })
      expect(events.find((e) => e.type === 'transcript')).toBeDefined()
      const [buf] = vi.mocked(audio.transcribe).mock.calls[0]!
      expect(buf.length).toBe(1)
    })
  })
})
