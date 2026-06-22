import { useRef, useState, useCallback } from 'react'

interface UseAudioPlaybackResult {
  isPlaying: boolean
  playChunk: (data: ArrayBuffer, sampleRate: number) => void
  stopPlayback: () => void
}

/**
 * Plays streaming PCM16 audio chunks via the Web Audio API. Chunks are queued
 * and played sequentially; stopPlayback() interrupts (e.g. on new capture).
 */
export function useAudioPlayback(): UseAudioPlaybackResult {
  const [isPlaying, setIsPlaying] = useState(false)

  const audioContextRef = useRef<AudioContext | null>(null)
  const queueRef = useRef<{ data: ArrayBuffer; sampleRate: number }[]>([])
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const playingRef = useRef(false)

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext()
    }
    return audioContextRef.current
  }, [])

  const playNext = useCallback(() => {
    const next = queueRef.current.shift()
    if (!next) {
      playingRef.current = false
      setIsPlaying(false)
      return
    }

    const ctx = getAudioContext()

    // Convert PCM16 to Float32 for the AudioBuffer.
    const int16 = new Int16Array(next.data)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i]! / 0x8000
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, next.sampleRate)
    audioBuffer.getChannelData(0).set(float32)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)
    currentSourceRef.current = source

    source.onended = () => {
      currentSourceRef.current = null
      playNext()
    }

    source.start()
  }, [getAudioContext])

  const playChunk = useCallback(
    (data: ArrayBuffer, sampleRate: number) => {
      if (data.byteLength === 0) return

      queueRef.current.push({ data, sampleRate })

      if (!playingRef.current) {
        playingRef.current = true
        setIsPlaying(true)
        playNext()
      }
    },
    [playNext],
  )

  const stopPlayback = useCallback(() => {
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop()
      } catch {
        // Already stopped.
      }
      currentSourceRef.current = null
    }
    queueRef.current = []
    playingRef.current = false
    setIsPlaying(false)
  }, [])

  return { isPlaying, playChunk, stopPlayback }
}
