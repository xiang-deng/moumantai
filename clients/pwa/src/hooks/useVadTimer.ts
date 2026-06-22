import { useCallback, useEffect, useRef } from 'react'

/**
 * VAD thresholds — mirror the Android client's `AudioConfig.kt`.
 *
 * - `VAD_VOICE_THRESHOLD`: per-chunk RMS above this counts as "speech" (~-40
 *   dBFS, matches Android).
 * - `VAD_SILENCE_TIMEOUT_MS`: once any speech has been detected, sustaining
 *   silence for this long auto-stops capture.
 * - `MAX_UTTERANCE_MS`: hard cap regardless of activity — prevents a stuck
 *   recording from running forever (Android: 30 s).
 */
export const VAD_VOICE_THRESHOLD = 0.01
export const VAD_SILENCE_TIMEOUT_MS = 1500
export const MAX_UTTERANCE_MS = 30_000

export interface UseVadTimerOptions {
  /** True while the mic is open. Arms the timers; flipping false clears them. */
  isCapturing: boolean
  /** Called when silence/timeout fires. Capture should stop. */
  onTimeout: () => void
}

/**
 * Returns a `notifyRms(rms)` function the caller must invoke for every chunk
 * coming out of the worklet:
 *
 *   - First chunk with `rms > VAD_VOICE_THRESHOLD` marks speech-detected.
 *   - Any subsequent below-threshold chunk arms a 1.5 s silence timer (reset
 *     on each above-threshold chunk).
 *   - A 30 s hard cap is armed when capture starts; fires unconditionally.
 *   - Both timers are cleared in cleanup OR when `isCapturing` goes false.
 */
export function useVadTimer({ isCapturing, onTimeout }: UseVadTimerOptions): (rms: number) => void {
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speechDetectedRef = useRef(false)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const clearTimers = useCallback(() => {
    if (silenceTimerRef.current != null) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (hardCapTimerRef.current != null) {
      clearTimeout(hardCapTimerRef.current)
      hardCapTimerRef.current = null
    }
    speechDetectedRef.current = false
  }, [])

  useEffect(() => {
    if (!isCapturing) {
      clearTimers()
      return
    }
    speechDetectedRef.current = false
    hardCapTimerRef.current = setTimeout(() => {
      onTimeoutRef.current()
    }, MAX_UTTERANCE_MS)
    return clearTimers
  }, [isCapturing, clearTimers])

  const notifyRms = useCallback(
    (rms: number) => {
      if (!isCapturing) return
      if (rms > VAD_VOICE_THRESHOLD) {
        speechDetectedRef.current = true
        if (silenceTimerRef.current != null) {
          clearTimeout(silenceTimerRef.current)
          silenceTimerRef.current = null
        }
        return
      }
      // Silence chunk. Only arm timeout once speech was once detected —
      // otherwise we'd auto-stop an idle mic before the user even spoke.
      if (!speechDetectedRef.current) return
      if (silenceTimerRef.current == null) {
        silenceTimerRef.current = setTimeout(() => {
          onTimeoutRef.current()
        }, VAD_SILENCE_TIMEOUT_MS)
      }
    },
    [isCapturing],
  )

  return notifyRms
}
