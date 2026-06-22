export type FaStyle = 'solid' | 'regular' | 'brands'

export type ParsedIcon =
  | { family: 'material'; id: string }
  | { family: 'fa'; id: string; faStyle: FaStyle }

/**
 * Parse a server-supplied icon identifier. Wire format is shared across all
 * clients: bare snake_case names are Material Symbols; `fa:...` opts into
 * FontAwesome with optional style (`fa:solid:star`, `fa:regular:bell`).
 */
export function parseIconName(raw: string | undefined | null): ParsedIcon | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (!trimmed.startsWith('fa:')) {
    return { family: 'material', id: trimmed }
  }

  const rest = trimmed.slice(3)
  if (!rest) return null

  const firstColon = rest.indexOf(':')
  if (firstColon === -1) {
    return { family: 'fa', id: rest, faStyle: 'solid' }
  }

  const maybeStyle = rest.slice(0, firstColon)
  if (maybeStyle === 'solid' || maybeStyle === 'regular' || maybeStyle === 'brands') {
    const id = rest.slice(firstColon + 1)
    if (!id) return null
    return { family: 'fa', id, faStyle: maybeStyle }
  }
  return { family: 'fa', id: rest, faStyle: 'solid' }
}

export function faStyleClass(style: FaStyle): string {
  return style === 'solid' ? 'fa-solid' : style === 'regular' ? 'fa-regular' : 'fa-brands'
}
