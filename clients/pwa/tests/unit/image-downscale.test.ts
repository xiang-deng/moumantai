import { describe, it, expect } from 'vitest'
import { computeScaledDimensions } from '../../src/chat/ImagePicker'

describe('computeScaledDimensions — Anthropic 1568px long-edge cap', () => {
  it('returns source dims unchanged when both edges are within budget', () => {
    expect(computeScaledDimensions(800, 600, 1568)).toEqual({ width: 800, height: 600 })
  })

  it('returns source dims unchanged at the exact boundary', () => {
    expect(computeScaledDimensions(1568, 1000, 1568)).toEqual({ width: 1568, height: 1000 })
  })

  it('scales landscape (3000×4000-ish flipped to landscape)', () => {
    // 4000×3000 → long edge 4000 → scale by 1568/4000 = 0.392
    const out = computeScaledDimensions(4000, 3000, 1568)
    expect(out.width).toBe(1568)
    expect(out.height).toBe(1176) // 3000 * 0.392 = 1176
  })

  it('scales portrait (3000×4000)', () => {
    const out = computeScaledDimensions(3000, 4000, 1568)
    expect(out.width).toBe(1176)
    expect(out.height).toBe(1568)
  })

  it('handles square images', () => {
    const out = computeScaledDimensions(3000, 3000, 1568)
    expect(out.width).toBe(1568)
    expect(out.height).toBe(1568)
  })

  it('preserves aspect ratio within ±1px rounding', () => {
    const out = computeScaledDimensions(1920, 1080, 1568)
    expect(out.width).toBe(1568)
    // 1080 * (1568/1920) = 882.0 — exact, no rounding wobble
    expect(out.height).toBe(882)
  })
})
