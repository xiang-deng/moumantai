/**
 * Lightweight haptic helper. Maps `light` and `medium` strengths to vibrate
 * pulses. Silently no-ops if `prefers-reduced-motion: reduce` or if the
 * Vibration API is unavailable (iOS Safari ignores `navigator.vibrate`).
 */
export type HapticStrength = 'light' | 'medium'

export function haptic(strength: HapticStrength = 'light'): void {
  if (typeof window === 'undefined') return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(strength === 'light' ? 10 : 20)
}
