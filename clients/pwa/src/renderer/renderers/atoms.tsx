import React from 'react'
import type {
  TextComponent,
  IconComponent,
  ImageComponent,
  DividerComponent,
} from '@moumantai/protocol/generated/moumantai/v1'
import { resolveImageFit } from '@moumantai/protocol/design-system'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic } from '../RenderNode'
import { resolveColor, resolveTypographyClass } from '../theme'
import { useDispatchArgs } from '../renderer-utils'
import { resolveAssetUrl } from '../../transport/asset-url'
import { fitKindToObjectFit } from '../variants'
import { IconGlyph } from './icon-glyph'

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function TextRenderer({
  def,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<TextComponent>) {
  const text = resolveDynamic(def.text, data, itemScope) as string | undefined
  const typClass = resolveTypographyClass(def.typography)
  const color = def.color ? resolveColor(def.color) : undefined

  // Block-level with whitespace preserved: matches Compose Text semantics —
  // `\n` produces real line breaks, spaces survive, long tokens wrap.
  // `<span>` is inline and ignores width/text-align; `<div>` fills the cross-axis.
  const style: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    ...modifierStyle,
  }
  if (color) style.color = color
  if (def.fontWeight) style.fontWeight = def.fontWeight
  if (def.textAlign) style.textAlign = def.textAlign as React.CSSProperties['textAlign']

  return (
    <div className={typClass} style={style}>
      {text ?? ''}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

export function IconRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<IconComponent>) {
  const name = resolveDynamic(def.name, data, itemScope) as string | undefined
  const size = def.size
  const color = def.color
    ? resolveColor(resolveDynamic(def.color, data, itemScope) as string)
    : undefined

  const style: React.CSSProperties = {
    ...modifierStyle,
    fontSize: size ? `${size}px` : 'var(--moumantai-icon-size)',
  }
  if (color) style.color = color
  if (def.action) style.cursor = 'pointer'

  const action = def.action
  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  return (
    <IconGlyph name={name} style={style} onClick={onClick} role={onClick ? 'button' : undefined} />
  )
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export function ImageRenderer({
  def,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<ImageComponent>) {
  const src = resolveDynamic(def.src, data, itemScope) as string | undefined
  const alt = def.alt ?? ''
  // resolveImageFit canonicalizes wire aliases and falls back to the catalog
  // default; fitKindToObjectFit maps the result to a valid CSS value.
  const fitKind = resolveImageFit(def.fit)

  const style: React.CSSProperties = {
    ...modifierStyle,
    objectFit: fitKindToObjectFit(fitKind),
    display: 'block',
  }

  return <img src={resolveAssetUrl(src)} style={style} alt={alt} loading="lazy" />
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export function DividerRenderer({ def, modifierStyle }: RendererProps<DividerComponent>) {
  const color = def.color ? resolveColor(def.color) : undefined
  const thickness = def.thickness ?? 1
  const style: React.CSSProperties = {
    ...modifierStyle,
    height: `${thickness}px`,
    background: color ?? 'var(--md-sys-color-outline-variant)',
    border: 'none',
  }
  return <hr className="moumantai-divider" style={style} />
}
