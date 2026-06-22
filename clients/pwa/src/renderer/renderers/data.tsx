import React, { useCallback } from 'react'
import type { ListComponent, ListItemComponent } from '@moumantai/protocol/generated/moumantai/v1'
import { resolveContainerChildGap } from '@moumantai/protocol/design-system'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic, RenderNode, parseSurfaceId, variantCaseToKind } from '../RenderNode'
import type { RenderParent } from '../RenderNode'
import { useAppStore } from '../stores/app-store'
import { resolvePointer } from '../data-model'
import { useDispatchArgs } from '../renderer-utils'
import { IconGlyph } from './icon-glyph'

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// Map a catalog spacing token to a CSS value. `spacing.none` → 0; other tokens
// resolve through the per-client tokens.css cascade for size-class variance.
function spacingTokenToCss(token: string | null): string | number | undefined {
  if (!token) return undefined
  if (token === 'spacing.none') return 0
  if (token.startsWith('spacing.'))
    return `var(--moumantai-spacing-${token.slice('spacing.'.length)})`
  return undefined
}

export function ListRenderer({
  def,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<ListComponent>) {
  const children = def.children
  // Hooks must run unconditionally — use a safe templateId even when absent.
  const templateId = children?.componentId
  const { appId, faceId } = parseSurfaceId(surfaceId)
  const templateDef = useAppStore(
    useCallback(
      (s) =>
        templateId == null
          ? undefined
          : s.apps.get(appId)?.faces.get(faceId)?.components.get(templateId),
      [appId, faceId, templateId],
    ),
  )

  if (!children) {
    return <div className="moumantai-list" style={modifierStyle} />
  }

  const { path, componentId } = children
  const fullPath = path.startsWith('/') ? path : itemScope ? `${itemScope}/${path}` : `/${path}`

  const items = resolvePointer(data, fullPath) as unknown[] | undefined
  if (!Array.isArray(items) || items.length === 0) {
    return <div className="moumantai-list" style={modifierStyle} />
  }

  const templateCase = templateDef?.component.case
  const templateKind = templateCase ? variantCaseToKind(templateCase) : 'default'
  const gap = spacingTokenToCss(resolveContainerChildGap('List', templateKind))

  const listItemParent: RenderParent = { kind: 'List', slotIndex: 0, slotName: null }
  const style: React.CSSProperties = gap !== undefined ? { gap, ...modifierStyle } : modifierStyle

  return (
    <div className="moumantai-list" style={style}>
      {items.map((_, i) => (
        <RenderNode
          key={`${fullPath}/${i}`}
          componentId={componentId}
          surfaceId={surfaceId}
          itemScope={`${fullPath}/${i}`}
          dispatch={dispatch}
          parent={listItemParent}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ListItem
// ---------------------------------------------------------------------------

export function ListItemRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<ListItemComponent>) {
  const headline = (resolveDynamic(def.headline, data, itemScope) as string) ?? ''
  const supporting = resolveDynamic(def.supporting, data, itemScope) as string | undefined
  const leadingIcon = resolveDynamic(def.leadingIcon, data, itemScope) as string | undefined
  const trailingContent = def.trailingContent
  const action = def.action

  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  const minHeight = supporting ? '72px' : '56px'

  return (
    <div
      className="moumantai-list-item"
      style={{ ...modifierStyle, minHeight }}
      data-clickable={!!action}
      onClick={onClick}
    >
      {leadingIcon && (
        <div className="moumantai-list-item-leading">
          <IconGlyph
            name={leadingIcon}
            style={{
              fontSize: 'var(--moumantai-icon-size)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
          />
        </div>
      )}
      <div className="moumantai-list-item-content">
        <span className="moumantai-list-item-headline">{headline}</span>
        {supporting && <span className="moumantai-list-item-supporting">{supporting}</span>}
      </div>
      {trailingContent && (
        <div className="moumantai-list-item-trailing">
          <RenderNode
            componentId={trailingContent}
            surfaceId={surfaceId}
            itemScope={itemScope}
            dispatch={dispatch}
            parent={{ kind: 'ListItem', slotIndex: 0, slotName: null } satisfies RenderParent}
          />
        </div>
      )}
    </div>
  )
}
