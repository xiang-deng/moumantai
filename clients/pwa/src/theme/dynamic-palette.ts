// M3 Expressive dynamic-palette runtime.
//
// Derives a full M3 palette from a seed hex and applies it as
// `--md-sys-color-*` custom properties on the target element.
//
// Uses `DynamicScheme` + `MaterialDynamicColors` with `Variant.TONAL_SPOT`
// (the Android default). The legacy `Scheme`/`applyTheme` API is deprecated
// and missing the 5 surface-container tones M3 Expressive's hierarchy requires.
//
// Why TONAL_SPOT and not VIBRANT/EXPRESSIVE:
//   - VIBRANT pumps neutral-palette chroma to ~12, making every surface read
//     as lavender on an indigo seed — the card hierarchy (filled/elevated/
//     outlined) becomes hard to distinguish.
//   - EXPRESSIVE rotates hue ~+60° from the seed ("playful" mode) — wrong
//     when the app declares a brand seed expecting that color to dominate.
//
// SPEC_2025 opts into the M3 Expressive 2025 color spec (Android 15+ default),
// which refines contrast handling over SPEC_2021.
//
// Each token is registered as a typed `<color>` via `CSS.registerProperty` so
// changes transition. A `:root { transition: … 500ms }` rule (injected once)
// cross-fades the palette on app-swipes; `prefers-reduced-motion` collapses it.

import {
  argbFromHex,
  DynamicScheme,
  Hct,
  hexFromArgb,
  MaterialDynamicColors,
  Variant,
} from '@material/material-color-utilities'

// Color roles projected onto CSS custom properties. Explicit list (not
// auto-discovered) — each entry must be a no-arg getter on MaterialDynamicColors.
const ROLES = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'error',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'surfaceDim',
  'surfaceBright',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'outline',
  'outlineVariant',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'shadow',
  'scrim',
  'surfaceTint',
] as const

type Role = (typeof ROLES)[number]

// Single shared instance — the class is stateless; each getter returns a
// DynamicColor resolved against the passed-in DynamicScheme.
const COLORS = new MaterialDynamicColors() as unknown as Record<
  Role,
  () => { getArgb(scheme: DynamicScheme): number }
>

function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

// ---------------------------------------------------------------------------
// One-time setup: register tokens as @property + inject transition rule.
// Idempotent across HMR / repeated imports.
// ---------------------------------------------------------------------------

function setupPaletteTransitions(): void {
  if (typeof window === 'undefined') return // SSR guard / jsdom test env

  // Register each role as `<color>` so changes are transitionable.
  // `CSS.registerProperty` throws if already registered — safe to catch (HMR).
  if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
    for (const role of ROLES) {
      const name = `--md-sys-color-${kebab(role)}`
      try {
        CSS.registerProperty({
          name,
          syntax: '<color>',
          inherits: true,
          initialValue: '#000000',
        })
      } catch {
        // Already registered (HMR or duplicate import) — fine.
      }
    }
  }

  // Inject one CSS rule transitioning all roles at 500ms M3 emphasized-decelerate.
  const styleId = 'moumantai-palette-transitions'
  if (document.getElementById(styleId)) return
  const easing = 'cubic-bezier(0.05, 0.7, 0.1, 1)'
  const duration = '500ms'
  const transitions = ROLES.map((r) => `--md-sys-color-${kebab(r)} ${duration} ${easing}`).join(
    ',\n              ',
  )
  const style = document.createElement('style')
  style.id = styleId
  style.textContent = `:root {
  transition: ${transitions};
}
@media (prefers-reduced-motion: reduce) {
  :root { transition: none; }
}`
  document.head.appendChild(style)
}

setupPaletteTransitions()

// ---------------------------------------------------------------------------
// applyPalette — public API.
// ---------------------------------------------------------------------------

/**
 * Compute an M3 palette from a seed and write it as `--md-sys-color-<role>`
 * custom properties on the target element. Idempotent for same-seed calls;
 * different seeds cross-fade via the :root transition rule.
 */
export function applyPalette(
  seedHex: string,
  isDark: boolean,
  target: HTMLElement = document.documentElement,
): void {
  const scheme = new DynamicScheme({
    sourceColorHct: Hct.fromInt(argbFromHex(seedHex)),
    variant: Variant.TONAL_SPOT,
    contrastLevel: 0,
    isDark,
    specVersion: '2025',
  })
  for (const role of ROLES) {
    const dynamicColor = COLORS[role]()
    const hex = hexFromArgb(dynamicColor.getArgb(scheme))
    target.style.setProperty(`--md-sys-color-${kebab(role)}`, hex)
  }
}

/**
 * Read the current theme from the `data-theme` attribute on the document
 * root. Defaults to light when the attribute is absent or unrecognized.
 */
export function isDarkTheme(target: HTMLElement = document.documentElement): boolean {
  return target.dataset.theme === 'dark'
}
