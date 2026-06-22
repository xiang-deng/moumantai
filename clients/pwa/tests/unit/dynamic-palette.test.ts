import { describe, it, expect, beforeEach } from 'vitest'
import { applyPalette, isDarkTheme } from '../../src/theme/dynamic-palette'

// The full M3 role set the runtime is contracted to emit. If the list ever
// diverges from MaterialDynamicColors getters this test surfaces it.
const REQUIRED_ROLES = [
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
  'secondary',
  'on-secondary',
  'secondary-container',
  'on-secondary-container',
  'tertiary',
  'on-tertiary',
  'tertiary-container',
  'on-tertiary-container',
  'error',
  'on-error',
  'error-container',
  'on-error-container',
  'background',
  'on-background',
  'surface',
  'on-surface',
  'surface-variant',
  'on-surface-variant',
  'surface-dim',
  'surface-bright',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'outline',
  'outline-variant',
  'inverse-surface',
  'inverse-on-surface',
  'inverse-primary',
  'shadow',
  'scrim',
  'surface-tint',
] as const

describe('applyPalette', () => {
  let target: HTMLDivElement

  beforeEach(() => {
    target = document.createElement('div')
  })

  it('writes every --md-sys-color-* token for the dark scheme', () => {
    applyPalette('#5B6CFF', true, target)
    for (const role of REQUIRED_ROLES) {
      const cssVar = `--md-sys-color-${role}`
      const value = target.style.getPropertyValue(cssVar)
      expect(value, `${cssVar} should be set`).toMatch(/^#[0-9a-fA-F]{6,8}$/)
    }
  })

  it('writes the same token set in the light scheme', () => {
    applyPalette('#5B6CFF', false, target)
    for (const role of REQUIRED_ROLES) {
      expect(target.style.getPropertyValue(`--md-sys-color-${role}`)).toMatch(/^#[0-9a-fA-F]{6,8}$/)
    }
  })

  it('produces distinct surface-container tones (5 levels — the M3 hierarchy)', () => {
    applyPalette('#5B6CFF', true, target)
    const tones = [
      target.style.getPropertyValue('--md-sys-color-surface-container-lowest'),
      target.style.getPropertyValue('--md-sys-color-surface-container-low'),
      target.style.getPropertyValue('--md-sys-color-surface-container'),
      target.style.getPropertyValue('--md-sys-color-surface-container-high'),
      target.style.getPropertyValue('--md-sys-color-surface-container-highest'),
    ]
    expect(new Set(tones).size, 'all 5 tones must differ').toBe(5)
  })

  it('different seeds yield different primary colors', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    applyPalette('#5B6CFF', true, a) // indigo
    applyPalette('#4CAF50', true, b) // green
    expect(a.style.getPropertyValue('--md-sys-color-primary')).not.toBe(
      b.style.getPropertyValue('--md-sys-color-primary'),
    )
  })

  it('same seed + theme = idempotent', () => {
    applyPalette('#5B6CFF', true, target)
    const before = target.style.getPropertyValue('--md-sys-color-primary')
    applyPalette('#5B6CFF', true, target)
    expect(target.style.getPropertyValue('--md-sys-color-primary')).toBe(before)
  })
})

describe('isDarkTheme', () => {
  it('returns true when data-theme is dark', () => {
    const el = document.createElement('div')
    el.dataset.theme = 'dark'
    expect(isDarkTheme(el)).toBe(true)
  })

  it('returns false otherwise', () => {
    const el = document.createElement('div')
    el.dataset.theme = 'light'
    expect(isDarkTheme(el)).toBe(false)
    delete el.dataset.theme
    expect(isDarkTheme(el)).toBe(false)
  })
})
