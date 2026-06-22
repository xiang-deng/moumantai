import { describe, it, expect } from 'vitest'

/**
 * Compute the page index closest to a scroll position. Used in M3 motion
 * polish to drive haptic on page snap. Kept here as a pure function so the
 * AppShell doesn't have to reach into DOM for unit tests.
 */
export function pageIndexFor(scroll: number, pageSize: number, pageCount: number): number {
  if (pageSize <= 0) return 0
  const idx = Math.round(scroll / pageSize)
  if (idx < 0) return 0
  if (idx >= pageCount) return pageCount - 1
  return idx
}

describe('AppShell snap math', () => {
  it('returns 0 at scroll position 0', () => {
    expect(pageIndexFor(0, 400, 3)).toBe(0)
  })

  it('rounds to nearest page boundary', () => {
    expect(pageIndexFor(199, 400, 3)).toBe(0)
    expect(pageIndexFor(201, 400, 3)).toBe(1)
  })

  it('clamps to last page', () => {
    expect(pageIndexFor(5000, 400, 3)).toBe(2)
  })

  it('returns 0 when pageSize is 0 (pre-layout)', () => {
    expect(pageIndexFor(100, 0, 3)).toBe(0)
  })

  it('handles single-page case', () => {
    expect(pageIndexFor(100, 400, 1)).toBe(0)
  })
})
