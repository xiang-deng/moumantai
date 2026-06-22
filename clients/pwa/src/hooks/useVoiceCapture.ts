import { useCallback, useRef, useState } from 'react'
import type { WebSocketTransport } from '../transport/ws-transport'

const TARGET_SAMPLE_RATE = 16000
const WORKLET_URL = '/audio-worklet/pcm-capture-worklet.js'

interface UseVoiceCaptureResult {
  isCapturing: boolean
  error: string | null
  /**
   * Synchronously prime the AudioContext (REQUIRED on iOS Safari, which only
   * unlocks audio when `new AudioContext() + resume()` is called inside the
   * user-gesture handler BEFORE the first `await`). Call this from the same
   * `onClick` that subsequently awaits `startCapture()`.
   */
  prepareAudio: () => void
  startCapture: () => Promise<void>
  stopCapture: () => void
}

/**
 * Mic capture → PCM16 chunks streamed via WebSocket.
 *
 * The worklet emits ~4096-sample (256 ms at 16 kHz) Int16Array chunks. We
 * compute RMS per chunk (Float32 mean-square) and forward via `onChunkRms`,
 * which `useVadTimer` consumes to detect silence and auto-stop.
 */
export function useVoiceCapture(
  transport: WebSocketTransport | null,
  scope: string,
  onChunkRms?: (rms: number) => void,
): UseVoiceCaptureResult {
  const [isCapturing, setIsCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const onChunkRef = useRef(onChunkRms)
  onChunkRef.current = onChunkRms

  const stopCapture = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) track.stop()
      mediaStreamRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }

    // Final empty chunk signals end-of-utterance.
    if (transport) {
      transport.sendAudioInput(new ArrayBuffer(0), 'pcm16', TARGET_SAMPLE_RATE, true, scope)
    }

    setIsCapturing(false)
  }, [transport, scope])

  const prepareAudio = useCallback(() => {
    // Must run synchronously inside the gesture handler, before any `await`
    // (iOS Safari requirement — see the doc comment above).
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') return
    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    audioContextRef.current = ctx
    ctx.resume().catch(() => {})
  }, [])

  const startCapture = useCallback(async () => {
    setError(null)

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      prepareAudio()
    }
    const audioCtx = audioContextRef.current!

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone permission denied'
      setError(msg)
      stopCapture()
      return
    }
    mediaStreamRef.current = stream

    try {
      await audioCtx.audioWorklet.addModule(WORKLET_URL)
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Audio worklet failed to load (iOS Safari requires 16.4+)'
      setError(msg)
      stopCapture()
      return
    }

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') return

    const source = audioCtx.createMediaStreamSource(stream)
    sourceRef.current = source

    const node = new AudioWorkletNode(audioCtx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    })
    workletNodeRef.current = node

    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (!transport) return
      if (onChunkRef.current) {
        const samples = new Int16Array(ev.data)
        let sumSquares = 0
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i]! / 0x8000
          sumSquares += s * s
        }
        const rms = Math.sqrt(sumSquares / samples.length)
        onChunkRef.current(rms)
      }
      transport.sendAudioInput(ev.data, 'pcm16', TARGET_SAMPLE_RATE, false, scope)
    }

    source.connect(node)
    node.connect(audioCtx.destination)

    setIsCapturing(true)
  }, [transport, scope, stopCapture, prepareAudio])

  return { isCapturing, error, prepareAudio, startCapture, stopCapture }
}
