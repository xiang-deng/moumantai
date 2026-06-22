/**
 * defineFace() helper for authoring app faces.
 *
 * Validates the face spec shape and returns a frozen FaceDefinition.
 * Used by developer-authored faces in apps/{id}/faces/*.ts files.
 */

import type { FaceDefinition, FaceResolve, ToolParameter, FaceBoundRefresh } from './types.js'
import type { ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
import { COMPACT_HINTS } from '@moumantai/protocol/design-system'

/**
 * Form-factor kind for a face. Pairs with the file-name suffix convention
 * (`<faceId>.compact.ts` / `<faceId>.expanded.ts`) — the suffix is the
 * source of truth at load time; `kind` is the author-facing way to
 * declare intent in code (and unblocks the compact-discipline guards).
 */
export type FaceKind = 'compact' | 'expanded'

/**
 * Define a face (a view in the app — read-only data display, optionally
 * parameterized for view-state steering).
 *
 * `viewToolDescription` is required for every face — it's the LLM-facing
 * one-liner the framework synthesizes a `view_<id>` tool from. UI tabs /
 * filter chips can also invoke that tool to navigate or steer view-state.
 *
 * `kind` declares the size class this face is authored for. `'compact'` is
 * ≤240dp; `'expanded'` is >240dp. The file-name suffix
 * (`<id>.compact.ts` / `<id>.expanded.ts`) is
 * the loader's source of truth — `kind` exists so authors declare it in code
 * (and so future compact-discipline guards can refuse phone-shaped compact
 * faces). Required when the explicit-suffix convention is used.
 *
 * ```typescript
 * export default defineFace({
 *   id: 'summary',
 *   label: 'Summary',
 *   kind: 'compact',
 *   position: 0,
 *   viewToolDescription: 'Show monthly spend. Pass month=YYYY-MM, omit for current.',
 *   params: {
 *     month: { type: 'string', description: 'Month YYYY-MM. Default: current.' },
 *   },
 *   components: [...],
 *   resolve: ({ db, params }) => ({...}),
 * })
 * ```
 */
export function defineFace(spec: {
  id: string
  label: string
  position: number
  viewToolDescription: string
  components: ComponentDef[]
  resolve: FaceResolve
  /** Form-factor this face is authored for. See `FaceKind` JSDoc. */
  kind?: FaceKind
  params?: Record<string, ToolParameter>
  paramsVersion?: number
  /**
   * Persistence semantics for `view_<id>` tool calls. `'replace'` (default)
   * overwrites the params row on every call; `'merge'` shallow-merges into
   * the existing params bag so chip-driven multi-dimension filters compose.
   * Requires `params` to be declared. See `FaceDefinition.paramsMerge`.
   */
  paramsMerge?: 'replace' | 'merge'
  /**
   * Optional face-bound refresh task. When set, the framework spawns one
   * worker per distinct (faceId, params) mount across all clients (deduped),
   * runs `run` at `every` (or `nextRun`), and kills it on unmount or params
   * change. Used for per-instance external data (e.g. game-detail polling).
   */
  refresh?: FaceBoundRefresh
}): FaceDefinition {
  if (!spec.id || typeof spec.id !== 'string') {
    throw new Error('defineFace: id is required and must be a string')
  }
  if (!spec.label || typeof spec.label !== 'string') {
    throw new Error('defineFace: label is required and must be a string')
  }
  if (typeof spec.position !== 'number') {
    throw new Error('defineFace: position is required and must be a number')
  }
  if (!spec.viewToolDescription || typeof spec.viewToolDescription !== 'string') {
    throw new Error(
      'defineFace: viewToolDescription is required (one-line description used by the synthesized view_<id> tool)',
    )
  }
  if (!Array.isArray(spec.components)) {
    throw new Error('defineFace: components is required and must be an array')
  }
  if (typeof spec.resolve !== 'function') {
    throw new Error('defineFace: resolve is required and must be a function')
  }
  if (spec.params !== undefined) {
    if (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params)) {
      throw new Error('defineFace: params must be a Record<string, ToolParameter>')
    }
  }
  if (
    spec.paramsVersion !== undefined &&
    (typeof spec.paramsVersion !== 'number' ||
      !Number.isInteger(spec.paramsVersion) ||
      spec.paramsVersion < 1)
  ) {
    throw new Error('defineFace: paramsVersion must be a positive integer')
  }
  if (spec.kind !== undefined && spec.kind !== 'compact' && spec.kind !== 'expanded') {
    throw new Error(
      `defineFace: kind must be "compact" or "expanded" (got ${JSON.stringify(spec.kind)})`,
    )
  }
  if (
    spec.paramsMerge !== undefined &&
    spec.paramsMerge !== 'replace' &&
    spec.paramsMerge !== 'merge'
  ) {
    throw new Error('defineFace: paramsMerge must be "replace" or "merge"')
  }
  if (spec.paramsMerge === 'merge' && !spec.params) {
    throw new Error(
      'defineFace: paramsMerge: "merge" requires `params` to be declared — there is nothing to merge into a paramless face',
    )
  }
  if (spec.refresh !== undefined) {
    if (typeof spec.refresh !== 'object' || spec.refresh === null) {
      throw new Error('defineFace: refresh must be an object')
    }
    if (typeof spec.refresh.every !== 'string' || spec.refresh.every.length === 0) {
      throw new Error('defineFace: refresh.every is required (e.g. "5s", "30s", "5m")')
    }
    if (typeof spec.refresh.run !== 'function') {
      throw new Error('defineFace: refresh.run is required and must be a function')
    }
  }

  if (spec.kind === 'compact') {
    runCompactDisciplineGuards(spec.id, spec.components)
  }

  return Object.freeze({
    id: spec.id,
    label: spec.label,
    position: spec.position,
    viewToolDescription: spec.viewToolDescription,
    components: spec.components,
    resolve: spec.resolve,
    ...(spec.kind !== undefined && { kind: spec.kind }),
    ...(spec.params !== undefined && { params: spec.params }),
    ...(spec.paramsVersion !== undefined && { paramsVersion: spec.paramsVersion }),
    ...(spec.paramsMerge !== undefined && { paramsMerge: spec.paramsMerge }),
    ...(spec.refresh !== undefined && { refresh: spec.refresh }),
  })
}

// ---------------------------------------------------------------------------
// Compact-discipline guards
// ---------------------------------------------------------------------------
//
// Compact faces (≤240dp) are glance-first. The rules
// below catch the most common phone-shaped-compact mistakes at face load.
// They emit warnings until every compact face declares an explicit suffix;
// promoted to thrown errors after that. Component-specific limits come from
// the design-system catalog; the face-level body limit remains local here.

// Per-face authoring hint — kept local to defineFace since "max body children"
// is a face-level rule, not a per-component catalog hint.
const COMPACT_MAX_BODY_CHILDREN = 6
// Per-component hints sourced from the design-system catalog
// (shared/protocol/design-system/design-system.yaml → COMPACT_HINTS). Defaults
// match the catalog values; fallbacks here let the guard stay functional even
// if the catalog row is removed.
const COMPACT_MAX_PROGRESS_SIZE_DP = COMPACT_HINTS.ProgressRing?.max_circular_size_dp ?? 100
const COMPACT_MAX_SELECTED_CHIPS_PER_ROW = COMPACT_HINTS.Row?.max_selected_chips ?? 2

// `ComponentDef` from protobuf-es uses a discriminated union — the variant
// payload lives at `component.value`, keyed by `component.case`. The guards
// below resolve through that shape; the cast keeps the function readable
// without dragging in the per-variant message types.
type VariantCase = 'scaffold' | 'column' | 'row' | 'chip' | 'progressRing'

function variantValue<T = unknown>(c: ComponentDef | undefined, kind: VariantCase): T | undefined {
  if (!c) return undefined
  const comp = (c as { component?: { case?: string; value?: unknown } }).component
  if (!comp || comp.case !== kind) return undefined
  return comp.value as T
}

function runCompactDisciplineGuards(faceId: string, components: ComponentDef[]): void {
  const byId = new Map<string, ComponentDef>()
  for (const c of components) {
    if (c.id) byId.set(c.id, c)
  }

  // Find the Scaffold (id="root") to discover the body component.
  const rootScaffold = variantValue<{ body?: string }>(byId.get('root'), 'scaffold')
  const bodyId = rootScaffold?.body
  const body = bodyId ? byId.get(bodyId) : undefined
  const bodyColumn = variantValue<{ children?: string[] }>(body, 'column')

  if (bodyColumn) {
    const bodyChildren = bodyColumn.children ?? []
    if (bodyChildren.length > COMPACT_MAX_BODY_CHILDREN) {
      warnCompactDiscipline(
        faceId,
        `body Column '${bodyId}' has ${bodyChildren.length} children (>${COMPACT_MAX_BODY_CHILDREN}). Compact faces are glance-first; split into sibling faces or use a list pattern.`,
      )
    }
  }

  // Scan every Row for >N selected-chip children (compact: vertical Column preferred).
  for (const c of components) {
    const rowVal = variantValue<{ children?: string[] }>(c, 'row')
    if (!rowVal) continue
    const rowId = c.id ?? '<unknown>'
    const rowChildIds = rowVal.children ?? []
    const selectedChips = rowChildIds.filter((cid) => {
      const child = byId.get(cid)
      const chipVal = variantValue<{ selected?: unknown }>(child, 'chip')
      return chipVal?.selected !== undefined
    })
    if (selectedChips.length > COMPACT_MAX_SELECTED_CHIPS_PER_ROW) {
      warnCompactDiscipline(
        faceId,
        `Row '${rowId}' contains ${selectedChips.length} chips with selected bindings (>${COMPACT_MAX_SELECTED_CHIPS_PER_ROW}). On round watch screens, horizontal chip rows overflow; use a Column or a chipRail-equivalent vertical layout on compact.`,
      )
    }
  }

  // Cap circular progress size at 100dp on compact (watch screens are typically ~192dp wide).
  for (const c of components) {
    const progressVal = variantValue<{ size?: number }>(c, 'progressRing')
    if (!progressVal) continue
    const size = progressVal.size
    if (typeof size === 'number' && size > COMPACT_MAX_PROGRESS_SIZE_DP) {
      warnCompactDiscipline(
        faceId,
        `ProgressRing '${c.id}' has size=${size}dp (>${COMPACT_MAX_PROGRESS_SIZE_DP}dp). On compact, the ring should leave room for the rest of the face — consider wrapping it in the hero pattern with a smaller size.`,
      )
    }
  }
}

function warnCompactDiscipline(faceId: string, message: string): void {
  console.warn(`[defineFace compact-discipline] face='${faceId}': ${message}`)
}
