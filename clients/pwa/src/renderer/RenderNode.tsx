import React, { useCallback } from 'react'
import { useAppStore } from './stores/app-store'
import { resolvePointer } from './data-model'
import { resolveColor } from './theme'
import type {
  ComponentDef,
  Modifier,
  Dimension,
  DynamicString,
  DynamicBool,
  DynamicInt32,
  DynamicDouble,
} from '@moumantai/protocol/generated/moumantai/v1'
import type { DispatchFn } from './action-dispatcher'
import {
  resolveChildWidth,
  resolveChildHeight,
  type LayoutSizeResult,
} from '@moumantai/protocol/design-system'

// ---------------------------------------------------------------------------
// RenderParent — context passed from a container to each child RenderNode
// so the catalog resolver knows which slot it occupies.
// ---------------------------------------------------------------------------

export interface RenderParent {
  kind: string | null
  slotIndex: number
  slotName: string | null
}

export const ROOT_PARENT: RenderParent = { kind: null, slotIndex: 0, slotName: null }

import { TextRenderer, IconRenderer, ImageRenderer, DividerRenderer } from './renderers/atoms'
import { ColumnRenderer, RowRenderer, CardRenderer, BoxRenderer } from './renderers/layout'
import { ScaffoldRenderer, TopBarRenderer } from './renderers/chrome'
import { ButtonRenderer, ChipRenderer, FabRenderer } from './renderers/actions'
import {
  TextFieldRenderer,
  CheckBoxRenderer,
  SwitchRenderer,
  SliderRenderer,
  TabsRenderer,
  SelectRenderer,
  DateTimeInputRenderer,
} from './renderers/input'
import { ListRenderer, ListItemRenderer } from './renderers/data'
import { ProgressRingRenderer, ProgressBarRenderer, ModalRenderer } from './renderers/feedback'

// ---------------------------------------------------------------------------
// Typed dynamic-value resolution
//
// Each Dynamic* wrapper is a oneof { literal | path }. These helpers branch
// on the case and JSON-Pointer-resolve `path` against the face data model.
// Relative paths inherit the current `itemScope` (set by List).
// ---------------------------------------------------------------------------

type AnyDynamic = DynamicString | DynamicBool | DynamicInt32 | DynamicDouble

function resolveByPath(path: string, data: Record<string, unknown>, itemScope?: string): unknown {
  if (path.startsWith('/')) return resolvePointer(data, path)
  // Strip JSONPath '$.' prefix for relative paths within list items
  const relativePath = path.startsWith('$.') ? path.slice(2) : path
  const fullPath = itemScope ? `${itemScope}/${relativePath}` : `/${relativePath}`
  return resolvePointer(data, fullPath)
}

export function resolveDynamic(
  v: AnyDynamic | undefined,
  data: Record<string, unknown>,
  itemScope?: string,
): unknown {
  if (v == null) return undefined
  const variant = v.value
  if (variant.case === 'literal') return variant.value
  if (variant.case === 'path') return resolveByPath(variant.value, data, itemScope)
  return undefined
}

/**
 * Some props (e.g. TextField.value, Switch.checked, Tabs.selected) accept a
 * Dynamic*-wrapped path that the renderer also writes back to. This helper
 * extracts the path for two-way binding.
 */
export function dynamicPath(v: AnyDynamic | undefined): string | undefined {
  if (v == null) return undefined
  return v.value.case === 'path' ? v.value.value : undefined
}

// ---------------------------------------------------------------------------
// Shared renderer props type — generic over the oneof variant payload type.
// ---------------------------------------------------------------------------

export interface RendererProps<T = unknown> {
  /** The typed variant message (e.g. TextComponent, ButtonComponent). */
  def: T
  /** Stable component id from the wrapping ComponentDef. Needed for dispatch. */
  componentId: string
  surfaceId: string
  data: Record<string, unknown>
  itemScope?: string
  dispatch: DispatchFn
  modifierStyle: React.CSSProperties
  parent: RenderParent
}

// ---------------------------------------------------------------------------
// Modifier resolution
// ---------------------------------------------------------------------------

function dimensionToCssPadding(dim: Dimension | undefined): string | undefined {
  if (!dim) return undefined
  const k = dim.kind
  if (k.case === 'dp') return `${k.value}px`
  if (k.case === 'edges') {
    const e = k.value
    const t = e.top ?? e.vertical ?? 0
    const r = e.end ?? e.horizontal ?? 0
    const b = e.bottom ?? e.vertical ?? 0
    const l = e.start ?? e.horizontal ?? 0
    return `${t}px ${r}px ${b}px ${l}px`
  }
  return undefined
}

/**
 * Apply width or height sizing to `style` via the catalog resolver.
 * An explicit dp value wins unconditionally; otherwise `LayoutSizeResult` maps to CSS.
 */
function applyResolvedSize(
  style: React.CSSProperties,
  parent: RenderParent,
  childKind: string,
  childVariant: string | null,
  explicitDp: number | undefined,
  ownKeyword: string | undefined,
  isWidth: boolean,
): void {
  if (explicitDp != null) {
    if (isWidth) style.width = `${explicitDp}px`
    else style.height = `${explicitDp}px`
    return
  }
  const result: LayoutSizeResult = isWidth
    ? resolveChildWidth(
        parent.kind,
        parent.slotIndex,
        parent.slotName,
        childKind,
        childVariant,
        ownKeyword ?? null,
      )
    : resolveChildHeight(
        parent.kind,
        parent.slotIndex,
        parent.slotName,
        childKind,
        childVariant,
        ownKeyword ?? null,
      )
  switch (result) {
    case 'fill':
      if (isWidth) {
        style.width = '100%'
        style.alignSelf = 'stretch'
      } else {
        style.height = '100%'
        style.alignSelf = 'stretch'
      }
      break
    case 'wrap':
      // Intrinsic content size — no explicit CSS value needed
      break
    case 'fixed':
      // Renderer default — don't override
      break
    case 'grow':
      style.flex = 1 // main-axis grow in any flex container
      break
  }
}

export function resolveModifierStyle(
  modifier: Modifier | undefined,
  data: Record<string, unknown>,
  itemScope: string | undefined,
  parent: RenderParent,
  childKind: string,
  childVariant: string | null,
): React.CSSProperties {
  const style: React.CSSProperties = {}
  if (!modifier) {
    applyResolvedSize(style, parent, childKind, childVariant, undefined, undefined, true)
    applyResolvedSize(style, parent, childKind, childVariant, undefined, undefined, false)
    return style
  }
  if (modifier.padding) style.padding = dimensionToCssPadding(modifier.padding)
  if (modifier.weight != null) style.flex = modifier.weight
  if (modifier.background) {
    const bg = resolveDynamic(modifier.background, data, itemScope) as string
    style.backgroundColor = resolveColor(bg)
  }
  // Extract explicit dp and keyword for width/height dimensions
  const wDim = modifier.width?.kind
  const hDim = modifier.height?.kind
  const wDp = wDim?.case === 'dp' ? wDim.value : undefined
  const wKeyword = wDim?.case === 'keyword' ? wDim.value : undefined
  const hDp = hDim?.case === 'dp' ? hDim.value : undefined
  const hKeyword = hDim?.case === 'keyword' ? hDim.value : undefined
  applyResolvedSize(style, parent, childKind, childVariant, wDp, wKeyword, true)
  applyResolvedSize(style, parent, childKind, childVariant, hDp, hKeyword, false)
  return style
}

/**
 * Visibility check. Returns true when the component should render.
 */
export function isVisible(
  modifier: Modifier | undefined,
  data: Record<string, unknown>,
  itemScope?: string,
): boolean {
  if (!modifier?.visible) return true
  return resolveDynamic(modifier.visible, data, itemScope) !== false
}

// ---------------------------------------------------------------------------
// RenderNode
// ---------------------------------------------------------------------------

interface RenderNodeProps {
  componentId: string
  surfaceId: string
  itemScope?: string
  dispatch: DispatchFn
  parent?: RenderParent // defaults to ROOT_PARENT
}

/**
 * Parse a surfaceId (appId:faceId) into parts.
 * Throws if the string is not in `appId:faceId` format — malformed surface ids
 * are authoring bugs and should fail loudly rather than silently mask errors.
 */
export function parseSurfaceId(surfaceId: string): { appId: string; faceId: string } {
  const idx = surfaceId.indexOf(':')
  if (idx === -1)
    throw new Error(`parseSurfaceId: invalid surfaceId "${surfaceId}" — expected "appId:faceId"`)
  return { appId: surfaceId.slice(0, idx), faceId: surfaceId.slice(idx + 1) }
}

/**
 * Type-narrowing helper used by every renderer to access its variant message.
 * The cast is safe because RenderNode dispatches based on the same
 * `def.component.case` discriminator that drove the renderer choice.
 */
function variantOf<T>(def: ComponentDef): T {
  return (def.component as unknown as { value: T }).value
}

/** Map proto oneof case (camelCase) to catalog component kind (PascalCase). */
export function variantCaseToKind(variantCase: string): string {
  switch (variantCase) {
    case 'text':
      return 'Text'
    case 'icon':
      return 'Icon'
    case 'image':
      return 'Image'
    case 'divider':
      return 'Divider'
    case 'column':
      return 'Column'
    case 'row':
      return 'Row'
    case 'card':
      return 'Card'
    case 'box':
      return 'Box'
    case 'scaffold':
      return 'Scaffold'
    case 'topBar':
      return 'TopBar'
    case 'button':
      return 'Button'
    case 'chip':
      return 'Chip'
    case 'textField':
      return 'TextField'
    case 'checkBox':
      return 'CheckBox'
    case 'switchToggle':
      return 'Switch'
    case 'slider':
      return 'Slider'
    case 'tabs':
      return 'Tabs'
    case 'select':
      return 'Select'
    case 'dateTimeInput':
      return 'DateTimeInput'
    case 'list':
      return 'List'
    case 'listItem':
      return 'ListItem'
    case 'progress':
      return 'Progress'
    case 'modal':
      return 'Modal'
    default:
      return variantCase
  }
}

export function RenderNode({
  componentId,
  surfaceId,
  itemScope,
  dispatch,
  parent = ROOT_PARENT,
}: RenderNodeProps) {
  // surfaceId is "appId:faceId" — read from app-store
  const { appId, faceId } = parseSurfaceId(surfaceId)

  const def = useAppStore(
    useCallback(
      (s) => s.apps.get(appId)?.faces.get(faceId)?.components.get(componentId),
      [appId, faceId, componentId],
    ),
  )
  const data = useAppStore(
    useCallback((s) => s.apps.get(appId)?.faces.get(faceId)?.data ?? {}, [appId, faceId]),
  ) as Record<string, unknown>

  if (!def) return null

  const variantCase = def.component.case
  if (variantCase === undefined) return null

  // Every variant message carries a `modifier?` at field 200.
  const variantMsg = (def.component as { value: { modifier?: Modifier; variant?: string } }).value
  const modifier = variantMsg.modifier
  // Variant string used by the catalog resolver (e.g. Progress.variant).
  const childVariant = variantMsg.variant ?? null

  // Visibility gate — skip render entirely when modifier.visible resolves false.
  if (!isVisible(modifier, data, itemScope)) return null

  const childKind = variantCaseToKind(variantCase)
  const modifierStyle = resolveModifierStyle(
    modifier,
    data,
    itemScope,
    parent,
    childKind,
    childVariant,
  )
  const props = {
    componentId: def.id,
    surfaceId,
    data,
    itemScope,
    dispatch,
    modifierStyle,
    parent,
  }

  switch (variantCase) {
    // atoms
    case 'text':
      return <TextRenderer def={variantOf(def)} {...props} />
    case 'icon':
      return <IconRenderer def={variantOf(def)} {...props} />
    case 'image':
      return <ImageRenderer def={variantOf(def)} {...props} />
    case 'divider':
      return <DividerRenderer def={variantOf(def)} {...props} />
    // layout
    case 'column':
      return <ColumnRenderer def={variantOf(def)} {...props} />
    case 'row':
      return <RowRenderer def={variantOf(def)} {...props} />
    case 'card':
      return <CardRenderer def={variantOf(def)} {...props} />
    case 'box':
      return <BoxRenderer def={variantOf(def)} {...props} />
    // chrome
    case 'scaffold':
      return <ScaffoldRenderer def={variantOf(def)} {...props} />
    case 'topBar':
      return <TopBarRenderer def={variantOf(def)} {...props} />
    // actions
    case 'button':
      return <ButtonRenderer def={variantOf(def)} {...props} />
    case 'chip':
      return <ChipRenderer def={variantOf(def)} {...props} />
    case 'fab':
      return <FabRenderer def={variantOf(def)} {...props} />
    // input
    case 'textField':
      return <TextFieldRenderer def={variantOf(def)} {...props} />
    case 'checkBox':
      return <CheckBoxRenderer def={variantOf(def)} {...props} />
    case 'switchToggle':
      return <SwitchRenderer def={variantOf(def)} {...props} />
    case 'slider':
      return <SliderRenderer def={variantOf(def)} {...props} />
    case 'tabs':
      return <TabsRenderer def={variantOf(def)} {...props} />
    case 'select':
      return <SelectRenderer def={variantOf(def)} {...props} />
    case 'dateTimeInput':
      return <DateTimeInputRenderer def={variantOf(def)} {...props} />
    // data
    case 'list':
      return <ListRenderer def={variantOf(def)} {...props} />
    case 'listItem':
      return <ListItemRenderer def={variantOf(def)} {...props} />
    // feedback
    case 'progressRing':
      return <ProgressRingRenderer def={variantOf(def)} {...props} />
    case 'progressBar':
      return <ProgressBarRenderer def={variantOf(def)} {...props} />
    case 'modal':
      return <ModalRenderer def={variantOf(def)} {...props} />
    default: {
      // Exhaustiveness guard: new oneof cases added to the generated proto
      // will make TypeScript flag this branch.
      const _exhaustive: never = variantCase
      void _exhaustive
      return (
        <div className="moumantai-placeholder" style={modifierStyle}>
          Unknown component variant
        </div>
      )
    }
  }
}
