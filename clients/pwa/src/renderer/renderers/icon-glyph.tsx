import React from 'react'
import { parseIconName, faStyleClass } from '../../icons/resolve'

/**
 * Shared glyph element for Icon/Button/Chip/ListItem.
 *
 * `fa:` prefix → FontAwesome `<i class="fa-solid fa-x">`;
 * otherwise → Material Symbols Rounded `<span>` with ligature rendering.
 *
 * Material Symbols variable axes: wght 100–700, FILL 0–1 (filled/outline),
 * GRAD −50..200, opsz 20–48. Pass `filled` for selected/active state;
 * the `font-variation-settings` transition animates automatically.
 */
export function IconGlyph({
  name,
  style,
  onClick,
  role,
  filled = false,
  weight = 400,
}: {
  name: string | undefined | null
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  role?: string
  filled?: boolean
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700
}) {
  const parsed = parseIconName(name ?? undefined)
  if (!parsed) return null

  if (parsed.family === 'fa') {
    return (
      <i
        className={`${faStyleClass(parsed.faStyle)} fa-${parsed.id}`}
        style={style}
        onClick={onClick}
        role={role}
      />
    )
  }

  const variation = `'opsz' 24, 'wght' ${weight}, 'FILL' ${filled ? 1 : 0}, 'GRAD' 0`
  const mergedStyle: React.CSSProperties = {
    fontVariationSettings: variation,
    transition: 'font-variation-settings 200ms cubic-bezier(0.05, 0.7, 0.1, 1)',
    ...style,
  }

  return (
    <span className="material-symbols-rounded" style={mergedStyle} onClick={onClick} role={role}>
      {parsed.id}
    </span>
  )
}
