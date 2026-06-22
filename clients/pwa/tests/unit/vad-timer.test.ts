import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useVadTimer,
  VAD_VOICE_THRESHOLD,
  VAD_SILENCE_TIMEOUT_MS,
  MAX_UTTERANCE_MS,
} from '../../src/hooks/useVadTimer'

describe('useVadTimer — Android-parity silence/timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(isCapturing: boolean) {
    const onTimeout = vi.fn()
    const { result, rerender } = renderHook(
      (props: { isCapturing: boolean }) =>
        useVadTimer({ isCapturing: props.isCapturing, onTimeout }),
      { initialProps: { isCapturing } },
    )
    return { result, rerender, onTimeout }
  }

  it('does not fire onTimeout while capture is off', () => {
    const { result, onTimeout } = setup(false)
    // Even a sustained silence shouldn't trigger when not capturing.
    act(() => {
      result.current(0) // silence
      vi.advanceTimersByTime(2 * VAD_SILENCE_TIMEOUT_MS)
    })
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('arms the silence timer only AFTER first speech-detected chunk', () => {
    const { result, onTimeout } = setup(true)

    // Pre-speech silence — should NOT arm the silence timer.
    act(() => {
      result.current(0)
      vi.advanceTimersByTime(VAD_SILENCE_TIMEOUT_MS + 100)
    })
    expect(onTimeout).not.toHaveBeenCalled()

    // Now speak.
    act(() => {
      result.current(VAD_VOICE_THRESHOLD + 0.05)
    })

    // Then go silent — silence timer arms; fires after VAD_SILENCE_TIMEOUT_MS.
    act(() => {
      result.current(0)
      vi.advanceTimersByTime(VAD_SILENCE_TIMEOUT_MS - 10)
    })
    expect(onTimeout).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('resets the silence timer on a subsequent above-threshold chunk', () => {
    const { result, onTimeout } = setup(true)
    act(() => {
      result.current(VAD_VOICE_THRESHOLD + 0.05) // speech
      result.current(0) // silence — timer armed
      vi.advanceTimersByTime(VAD_SILENCE_TIMEOUT_MS - 200)
      result.current(VAD_VOICE_THRESHOLD + 0.05) // speech again — timer cleared
      vi.advanceTimersByTime(VAD_SILENCE_TIMEOUT_MS + 100)
    })
    // No timeout — every silence period was interrupted before 1500ms.
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('fires hard-cap after MAX_UTTERANCE_MS regardless of activity', () => {
    const { result, onTimeout } = setup(true)
    // Continuous speech keeps the silence timer disarmed, but the 30 s cap
    // still fires.
    act(() => {
      for (let t = 0; t < MAX_UTTERANCE_MS + 1000; t += 250) {
        result.current(VAD_VOICE_THRESHOLD + 0.05)
        vi.advanceTimersByTime(250)
      }
    })
    expect(onTimeout).toHaveBeenCalled()
  })

  it('clears all timers when capture flips to false', () => {
    const { result, rerender, onTimeout } = setup(true)
    act(() => {
      result.current(VAD_VOICE_THRESHOLD + 0.05)
      result.current(0)
    })
    rerender({ isCapturing: false })
    act(() => {
      vi.advanceTimersByTime(MAX_UTTERANCE_MS + 10_000)
    })
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
