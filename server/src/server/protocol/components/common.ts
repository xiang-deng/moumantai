/**
 * Shared helpers, types, and action builders used by all component categories.
 *
 * The `component()` factory constructs typed protobuf-es message instances
 * directly. The DSL surface uses snake_case `*Options` interfaces (ergonomic
 * for authors); the factory maps them into typed proto setters. Wire shape is
 * native typed proto from construction through encode — no reshape on the
 * outbound path.
 */

import { create } from '@bufbuild/protobuf'
import type { JsonObject } from '@bufbuild/protobuf'
import type { SizeValue, Alignment } from '@moumantai/protocol/design-system/sdk-types'
import type {
  ComponentDef,
  Modifier,
  Dimension,
  PaddingEdges,
  SelectOption,
  SelectOptions,
  ListChildren,
  Action,
  DynamicString,
  DynamicBool,
  DynamicInt32,
  DynamicDouble,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  ComponentDefSchema,
  ModifierSchema,
  DimensionSchema,
  PaddingEdgesSchema,
  SelectOptionSchema,
  SelectOptionsSchema,
  ListChildrenSchema,
  ActionSchema,
  DynamicStringSchema,
  DynamicBoolSchema,
  DynamicInt32Schema,
  DynamicDoubleSchema,
} from '@moumantai/protocol/generated/moumantai/v1'
import { factoryDispatch } from './generated/factory.js'

// ---------------------------------------------------------------------------
// Re-export typed shared types so category files only import from './common.js'
// ---------------------------------------------------------------------------

export type { ComponentDef, Action }

/**
 * DSL dynamic value: a bare literal, a path reference `{ path: '/...' }`,
 * or an already-typed proto message (builders may pass through directly).
 */
export type DynamicValue<T extends string | boolean | number> =
  | T
  | { path: string }
  | DynamicString
  | DynamicBool
  | DynamicInt32
  | DynamicDouble

/**
 * SelectOptions input shape — accepted by `select()` builders. The factory
 * wraps either form into the typed `SelectOptions` proto message.
 */
export type SelectOptionsInput =
  | Array<{ label: string; value: string }>
  | { path: string }
  | SelectOptions

/**
 * ListChildren input shape — accepted by `list()` builder. The factory
 * wraps into the typed `ListChildren` proto message.
 */
export type ListChildrenInput =
  | { path: string; componentId?: string; component_id?: string }
  | ListChildren

// ---------------------------------------------------------------------------
// Common modifier props (all components can have these)
// ---------------------------------------------------------------------------

export interface ModifierProps {
  padding?: string | number | Record<string, number>
  width?: SizeValue
  height?: SizeValue
  background?: DynamicValue<string>
  visible?: DynamicValue<boolean>
  weight?: number
}

export type { SizeValue, Alignment }

// ---------------------------------------------------------------------------
// Dynamic-value coercion helpers
// ---------------------------------------------------------------------------

function isPathRef(v: unknown): v is { path: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    'path' in v &&
    typeof (v as { path: unknown }).path === 'string'
  )
}

function isProtoMessage(v: unknown): v is { $typeName: string } {
  return typeof v === 'object' && v !== null && '$typeName' in v
}

/** Wrap a bare string / `{path}` / typed `DynamicString` into a typed `DynamicString`. */
export function dynString(v: DynamicValue<string> | undefined): DynamicString | undefined {
  if (v === undefined) return undefined
  if (
    isProtoMessage(v) &&
    (v as { $typeName: string }).$typeName === 'moumantai.v1.DynamicString'
  ) {
    return v as DynamicString
  }
  if (isPathRef(v)) {
    return create(DynamicStringSchema, { value: { case: 'path', value: v.path } })
  }
  return create(DynamicStringSchema, { value: { case: 'literal', value: v as string } })
}

/** Wrap a bare bool / `{path}` / typed `DynamicBool` into a typed `DynamicBool`. */
export function dynBool(v: DynamicValue<boolean> | undefined): DynamicBool | undefined {
  if (v === undefined) return undefined
  if (isProtoMessage(v) && (v as { $typeName: string }).$typeName === 'moumantai.v1.DynamicBool') {
    return v as DynamicBool
  }
  if (isPathRef(v)) {
    return create(DynamicBoolSchema, { value: { case: 'path', value: v.path } })
  }
  return create(DynamicBoolSchema, { value: { case: 'literal', value: v as boolean } })
}

/** Wrap a bare int / `{path}` / typed `DynamicInt32` into a typed `DynamicInt32`. */
export function dynInt32(v: DynamicValue<number> | undefined): DynamicInt32 | undefined {
  if (v === undefined) return undefined
  if (isProtoMessage(v) && (v as { $typeName: string }).$typeName === 'moumantai.v1.DynamicInt32') {
    return v as DynamicInt32
  }
  if (isPathRef(v)) {
    return create(DynamicInt32Schema, { value: { case: 'path', value: v.path } })
  }
  return create(DynamicInt32Schema, { value: { case: 'literal', value: v as number } })
}

/** Wrap a bare number / `{path}` / typed `DynamicDouble` into a typed `DynamicDouble`. */
export function dynDouble(v: DynamicValue<number> | undefined): DynamicDouble | undefined {
  if (v === undefined) return undefined
  if (
    isProtoMessage(v) &&
    (v as { $typeName: string }).$typeName === 'moumantai.v1.DynamicDouble'
  ) {
    return v as DynamicDouble
  }
  if (isPathRef(v)) {
    return create(DynamicDoubleSchema, { value: { case: 'path', value: v.path } })
  }
  return create(DynamicDoubleSchema, { value: { case: 'literal', value: v as number } })
}

// ---------------------------------------------------------------------------
// Dimension / Modifier construction
// ---------------------------------------------------------------------------

/** Coerce a Dimension input — dp number, keyword string, or per-edge object — into a typed `Dimension`. */
function dimension(v: string | number | Record<string, number> | undefined): Dimension | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') {
    return create(DimensionSchema, { kind: { case: 'dp', value: v } })
  }
  if (typeof v === 'string') {
    // Numeric strings (e.g. `'16'`) are coerced to dp. Keywords pass through.
    const asNum = Number(v)
    if (Number.isFinite(asNum) && /^-?\d+(\.\d+)?$/.test(v)) {
      return create(DimensionSchema, { kind: { case: 'dp', value: asNum } })
    }
    return create(DimensionSchema, { kind: { case: 'keyword', value: v } })
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const edges: PaddingEdges = create(PaddingEdgesSchema, {
      top: v['top'],
      bottom: v['bottom'],
      start: v['start'],
      end: v['end'],
      horizontal: v['horizontal'],
      vertical: v['vertical'],
    })
    return create(DimensionSchema, { kind: { case: 'edges', value: edges } })
  }
  return undefined
}

/**
 * Build a Modifier from `padding/width/height/background/visible/weight` props.
 * Returns undefined if none are set.
 *
 * `width: 'grow'` / `height: 'grow'` normalize to `weight: 1` so renderers
 * see a single mechanism for proportional main-axis sizing. Explicit numeric
 * `weight` wins over the 'grow' shorthand.
 */
export function buildModifier(props: ModifierProps): Modifier | undefined {
  let userWidth = props.width
  let userHeight = props.height
  let userWeight = props.weight
  if (userWidth === 'grow') {
    if (userWeight === undefined) userWeight = 1
    userWidth = undefined
  }
  if (userHeight === 'grow') {
    if (userWeight === undefined) userWeight = 1
    userHeight = undefined
  }

  const padding = dimension(props.padding)
  const width = dimension(userWidth)
  const height = dimension(userHeight)
  const background = dynString(props.background)
  const visible = dynBool(props.visible)
  const weight = userWeight
  const anySet =
    padding !== undefined ||
    width !== undefined ||
    height !== undefined ||
    background !== undefined ||
    visible !== undefined ||
    weight !== undefined
  if (!anySet) return undefined
  const init: Partial<Modifier> = {}
  if (padding !== undefined) init.padding = padding
  if (width !== undefined) init.width = width
  if (height !== undefined) init.height = height
  if (background !== undefined) init.background = background
  if (visible !== undefined) init.visible = visible
  if (weight !== undefined) init.weight = weight
  return create(ModifierSchema, init)
}

// ---------------------------------------------------------------------------
// Component factory — delegates to the generated dispatch table
// (`./generated/factory.ts`). Per-variant build* functions are derived
// directly from `components.proto`, so adding a proto field flows through
// the Options interface and ComponentDef construction automatically.
// ---------------------------------------------------------------------------

// Internal payload type — keys are snake_case as authored in the *Options
// interfaces.
type AnyProps = Record<string, any>

/**
 * Build a typed `ComponentDef`. `type` is the PascalCase label (e.g. `'Text'`,
 * `'Switch'`) — looked up in the generated factory dispatch table. Unknown
 * types emit the wrapper id only (no variant) for graceful degradation.
 */
export function component(id: string, type: string, props: AnyProps): ComponentDef {
  const build = factoryDispatch[type]
  if (build) return build(id, props)
  return create(ComponentDefSchema, { id })
}

/**
 * Build a typed `SelectOptions` from the DSL input:
 *   - `[{ label, value }, ...]`  → `{ literal: { options: [...] } }`
 *   - `{ path: '/items' }`       → `{ path: '/items' }`
 *   - already typed `SelectOptions` → pass through.
 */
export function selectOptions(v: unknown): SelectOptions | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) {
    const opts: SelectOption[] = v.map((o) => {
      const obj = o as { label?: string; value?: string }
      return create(SelectOptionSchema, { label: obj.label ?? '', value: obj.value ?? '' })
    })
    return create(SelectOptionsSchema, {
      value: {
        case: 'literal',
        value: { $typeName: 'moumantai.v1.SelectOptionList', options: opts },
      },
    })
  }
  if (isPathRef(v)) {
    return create(SelectOptionsSchema, { value: { case: 'path', value: v.path } })
  }
  if (
    isProtoMessage(v) &&
    (v as { $typeName: string }).$typeName === 'moumantai.v1.SelectOptions'
  ) {
    return v as SelectOptions
  }
  return undefined
}

/**
 * Wrap a `{ path, componentId | component_id }` shape (or already-typed
 * `ListChildren`) into a typed `ListChildren` proto message. Accepts both
 * snake_case (`component_id`) and camelCase (`componentId`) for the
 * template id so DSL authors can use whichever they prefer.
 */
export function listChildren(v: unknown): ListChildren | undefined {
  if (v === undefined || v === null) return undefined
  if (isProtoMessage(v) && (v as { $typeName: string }).$typeName === 'moumantai.v1.ListChildren') {
    return v as ListChildren
  }
  const obj = v as { path?: string; componentId?: string; component_id?: string }
  return create(ListChildrenSchema, {
    path: obj.path ?? '',
    componentId: obj.componentId ?? obj.component_id ?? '',
  })
}

// ---------------------------------------------------------------------------
// Action helper — the unified component-action builder
// ---------------------------------------------------------------------------

/**
 * Build a typed `Action` referencing a tool by name. `args` may contain
 * `{path: "..."}` placeholders resolved client-side against face data,
 * item scope (`$.field`), or the per-face `/$form/...` form-state map.
 *
 * `tool` is either an app-defined tool name or the framework-synthesized
 * `view_<faceId>` for view-param steering.
 *
 * `escalationPrompt`: message shown to the user when the invocation reports
 * missing required args, bypassing the LLM's "what do you want?" turn.
 * The user's next reply runs the agent loop as normal.
 */
export function invokeTool(
  tool: string,
  args?: Record<string, unknown>,
  opts?: { escalationPrompt?: string },
): Action {
  return create(ActionSchema, {
    tool,
    args: args as JsonObject | undefined,
    ...(opts?.escalationPrompt !== undefined ? { escalationPrompt: opts.escalationPrompt } : {}),
  })
}

// ---------------------------------------------------------------------------
// Path reference helper — DSL-side `pathRef('/foo')` shorthand.
// Returns `{ path }`. The dyn* coercers wrap it into the matching typed
// Dynamic* message at component construction time; action args use the same
// shape for client-side path placeholders.
// ---------------------------------------------------------------------------

export function pathRef(path: string): { path: string } {
  return { path }
}
