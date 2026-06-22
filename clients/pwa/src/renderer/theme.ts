// Theme resolution utilities -- port of web/theme.js

const COLOR_TOKENS = new Set([
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
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'surfaceContainerLow',
  'surfaceContainerLowest',
  'inverseSurface',
  'inverseOnSurface',
  'outline',
  'outlineVariant',
  'surfaceDim',
  'surfaceBright',
  'scrim',
  'shadow',
])

function toKebabCase(str: string): string {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase()
}

export function resolveColor(token: string): string | undefined {
  if (!token) return undefined
  if (token.startsWith('#') || token.startsWith('rgb') || token.startsWith('hsl')) {
    return token
  }
  if (token === 'muted') return 'var(--md-sys-color-on-surface-variant)'
  const kebab = toKebabCase(token)
  if (COLOR_TOKENS.has(token)) {
    return `var(--md-sys-color-${kebab})`
  }
  return `var(--md-sys-color-${kebab}, var(--md-sys-color-on-surface))`
}

export function resolveTypographyClass(token: string | undefined): string {
  if (!token) return 'md-typescale-body-medium'
  return `md-typescale-${toKebabCase(token)}`
}
