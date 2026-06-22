/**
 * Face component validation.
 *
 * Walks a FaceDefinition's component graph and reports authoring errors that
 * would otherwise produce a silently-blank render — most commonly dangling ID
 * references (e.g. `Column.children: ['heading']` when the component is named
 * `'header'`) and unknown variant strings.
 *
 * `validateFaceComponents` is pure: it returns issues as data. `enforceFaceValidation`
 * applies the policy (throw on errors, log warnings) and is the choke point
 * called from FaceRegistry.register(). Splitting collection from policy keeps
 * the validator testable and lets callers (tests, dry-run tools) consume issues
 * without committing to a side effect.
 */

import type { ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
import { ComponentDefSchema } from '@moumantai/protocol/generated/moumantai/v1'
import { toBinary } from '@bufbuild/protobuf'
import type { FaceDefinition } from './types.js'
import { DESIGN_SYSTEM, IMAGE_FIT_ALIASES } from '@moumantai/protocol/design-system'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single validation finding produced for a face. */
export interface FaceValidationIssue {
  /** `error` halts app load; `warning` is logged and ignored. */
  level: 'error' | 'warning'
  /** Stable code: `missing-root` | `duplicate-id` | `unknown-ref` | `unknown-variant`. */
  code: string
  /** Human-readable message including the offending reference / id. */
  message: string
  /** The component id holding the problem (when applicable). */
  componentId?: string
}

// ---------------------------------------------------------------------------
// Internal: extract the ID-reference fields for a single ComponentDef
// ---------------------------------------------------------------------------

/**
 * Map a component to the list of ID-string references it carries. These are
 * exactly the fields that name *another* component in the same face — NOT
 * `pathRef` strings, NOT data paths, NOT variant strings.
 *
 * Mirrors the case dispatch in `protocol/components/common.ts` so the two
 * stay aligned: any new ID-bearing field must be added here too.
 *
 * Exported so `define-widget.ts` can reuse the SAME case dispatch when
 * scanning a widget's expansion for cross-namespace ID leaks. Forking a
 * second copy would let the two drift apart silently as new ID-bearing
 * fields are added to components.
 */
export function idRefsOf(c: ComponentDef): string[] {
  const inner = c.component
  if (!inner || !inner.case) return []
  const v = inner.value as Record<string, unknown> | undefined
  if (!v) return []

  switch (inner.case) {
    case 'column':
    case 'row':
    case 'card':
    case 'box':
    case 'modal':
      return arrayOf(v['children'])

    case 'scaffold':
      // single-string slots; empty/undefined is OK (means no chrome in that slot)
      return [v['topBar'], v['body'], v['fab']].filter(isNonEmptyString)

    case 'topBar':
      return arrayOf(v['actions'])

    case 'tabs':
      return arrayOf(v['tabContent'])

    case 'listItem': {
      const t = v['trailingContent']
      return isNonEmptyString(t) ? [t] : []
    }

    case 'list': {
      // ListChildren.componentId — the per-item template id.
      const lc = v['children'] as { componentId?: unknown } | undefined
      const cid = lc?.componentId
      return isNonEmptyString(cid) ? [cid] : []
    }

    // Components that do NOT reference other components by id:
    //   text, icon, image, divider,
    //   button, chip, textField, checkBox, switchToggle, slider, select,
    //   dateTimeInput, progress
    default:
      return []
  }
}

function arrayOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (isNonEmptyString(item)) out.push(item)
  }
  return out
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

// ---------------------------------------------------------------------------
// Internal: stylistic-string warnings (Image fit only)
// ---------------------------------------------------------------------------
//
// With the intent-driven component model, Button/Card/Chip have no `variant`
// field. Authors emit `emphasis` / `tone` instead — both are
// free-form strings (per `shared/protocol/CLAUDE.md` rule 7) that silently
// fall back to a default treatment when unknown. Compile-time typing via the
// SDK options interface (typed against `ButtonEmphasis | ButtonTone | …`
// unions from `sdk-types.ts`) catches typos at author time; runtime
// validation here would just duplicate that.
//
// Image `fit` is kept under runtime validation because its accepted values
// are a closed set the catalog declares (not author-extendable). A typo
// there silently collapses to `contain` — worth a warning.

/** Read the `fit` string off an Image component, if set. */
function imageFitOf(c: ComponentDef): string | undefined {
  if (c.component?.case !== 'image') return undefined
  const v = c.component.value as Record<string, unknown> | undefined
  const fit = v?.['fit']
  return isNonEmptyString(fit) ? fit : undefined
}

/** True if `value` is a known Image fit mode (or alias). */
function isKnownImageFit(value: string): boolean {
  if (value in IMAGE_FIT_ALIASES) return true
  const modes = DESIGN_SYSTEM.Image.fitModes as readonly string[]
  return modes.includes(value)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a face's component graph.
 *
 * Checks (in priority order):
 *   1. Root: exactly one `id === 'root'` of case `'scaffold'` or `'column'`.
 *   2. ID uniqueness within the face.
 *   3. ID references resolve to a component defined in the same face.
 *   4. Variant strings are known in the design-system catalog (warning only).
 *
 * Returns the full list of issues; never throws. The caller decides policy.
 */
export function validateFaceComponents(face: FaceDefinition): FaceValidationIssue[] {
  const issues: FaceValidationIssue[] = []
  const components = face.components

  // An empty components array is a programmatic / placeholder face (e.g.
  // resolve-only). There's nothing to validate; bail before flagging
  // missing-root, which would be a false positive here.
  if (components.length === 0) return issues

  // ---- (1) Root
  const root = components.find((c) => c.id === 'root')
  if (!root) {
    issues.push({
      level: 'error',
      code: 'missing-root',
      message: `face "${face.id}" has no component with id="root"`,
    })
  } else {
    const rootCase = root.component?.case
    if (rootCase !== 'scaffold' && rootCase !== 'column') {
      issues.push({
        level: 'error',
        code: 'missing-root',
        message: `face "${face.id}" root component must be Scaffold or Column (got ${rootCase ?? 'unset'})`,
        componentId: 'root',
      })
    }
  }

  // ---- (2) ID uniqueness
  const seen = new Set<string>()
  const knownIds = new Set<string>()
  for (const c of components) {
    if (!c.id) continue // empty-id wrapper — skip; not our problem here
    if (seen.has(c.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate-id',
        message: `face "${face.id}" has duplicate component id "${c.id}"`,
        componentId: c.id,
      })
    } else {
      seen.add(c.id)
    }
    knownIds.add(c.id)
  }

  // ---- (3) ID references resolve
  for (const c of components) {
    for (const ref of idRefsOf(c)) {
      if (!knownIds.has(ref)) {
        issues.push({
          level: 'error',
          code: 'unknown-ref',
          message: `face "${face.id}" component "${c.id}" references unknown id "${ref}"`,
          componentId: c.id,
        })
      }
    }
  }

  // ---- (4) Image fit values (intent fields on Button/Card/Chip are typed
  //          via SDK options; typos caught at compile time).
  for (const c of components) {
    const fit = imageFitOf(c)
    if (fit !== undefined && !isKnownImageFit(fit)) {
      issues.push({
        level: 'warning',
        code: 'unknown-variant',
        message: `face "${face.id}" component "${c.id}" uses unknown image fit "${fit}"`,
        componentId: c.id,
      })
    }
  }

  // ---- (5) List-template input guard — reject inputs inside repeating lists.
  //
  // Each row of a list shares the same component-`id` with every other row, so
  // an input writing to `/$form/<id>` would collide across rows (last-row-wins,
  // silent breakage). The supported pattern is "tap a row → modal opens with
  // the form" — modal lifts the form out of the list scope.
  //
  // Inputs ARE allowed in a list row when they have an `action` set: those fire
  // immediately on change with the row's itemScope, no `$form` write needed
  // (toggle-task style — checkbox inside each row).
  validateListTemplateInputs(face, components, issues)

  // ---- (6) Params shape (only when params declared)
  if (face.params !== undefined) {
    // (5a) viewToolDescription required when params declared.
    // (defineFace also enforces this, but face validation is the canonical
    // gate for faces that bypass defineFace — e.g. tests or future loaders.)
    if (!face.viewToolDescription || typeof face.viewToolDescription !== 'string') {
      issues.push({
        level: 'error',
        code: 'missing-view-tool-description',
        message: `face "${face.id}" declares params but is missing viewToolDescription`,
      })
    }

    // (5b) All params must be optional. The agent uses `view_<id>({})` to
    // reset; resolvers always supply defaults via `??`. Required params would
    // make the synth tool reject empty calls, breaking the reset path.
    for (const [paramName, paramSpec] of Object.entries(face.params)) {
      if (paramSpec && (paramSpec as { required?: boolean }).required === true) {
        issues.push({
          level: 'error',
          code: 'required-face-param',
          message: `face "${face.id}" param "${paramName}" must not be required — face params are always optional; resolvers fill defaults`,
        })
      }
    }

    // (5c) Face id starting with `view_` would synthesize `view_view_*`.
    if (face.id.startsWith('view_')) {
      issues.push({
        level: 'error',
        code: 'reserved-face-id-prefix',
        message: `face "${face.id}" declares params; face ids starting with "view_" are reserved (synth tool would be "view_view_${face.id.slice(5)}")`,
      })
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// List-template input guard
// ---------------------------------------------------------------------------

/**
 * Component oneof cases for input components that default-bind to `/$form/<id>`
 * when no `action` is set. With `action` set they fire on change instead.
 *
 * `textField` is special: there's no fire-on-every-keystroke mode, so it ALWAYS
 * writes to `$form` and is always rejected in list templates.
 */
const FORM_BINDING_INPUT_CASES = new Set([
  'slider',
  'switchToggle',
  'checkBox',
  'select',
  'dateTimeInput',
])

function hasComponentAction(c: ComponentDef): boolean {
  const inner = c.component
  if (!inner || !inner.case) return false
  const v = inner.value as Record<string, unknown> | undefined
  if (!v) return false
  return v['action'] !== undefined && v['action'] !== null
}

/**
 * Walk every list template in the face. If any descendant of a template is a
 * form-binding input without an `action`, report an error pointing the author
 * to the modal-edit pattern.
 */
function validateListTemplateInputs(
  face: FaceDefinition,
  components: ComponentDef[],
  issues: FaceValidationIssue[],
): void {
  const byId = new Map<string, ComponentDef>()
  for (const c of components) if (c.id) byId.set(c.id, c)

  // Find every list template id (the `componentId` slot in `ListChildren`).
  const templateIds: string[] = []
  for (const c of components) {
    if (c.component?.case !== 'list') continue
    const lc = (c.component.value as { children?: { componentId?: string } } | undefined)?.children
    const cid = lc?.componentId
    if (typeof cid === 'string' && cid.length > 0) templateIds.push(cid)
  }
  if (templateIds.length === 0) return

  for (const templateId of templateIds) {
    walkSubtreeForFormInputs(face, templateId, byId, issues, new Set())
  }
}

function walkSubtreeForFormInputs(
  face: FaceDefinition,
  rootId: string,
  byId: Map<string, ComponentDef>,
  issues: FaceValidationIssue[],
  visited: Set<string>,
): void {
  if (visited.has(rootId)) return
  visited.add(rootId)
  const c = byId.get(rootId)
  if (!c) return

  const caseKey = c.component?.case
  if (caseKey === 'textField') {
    issues.push({
      level: 'error',
      code: 'list-template-input',
      message:
        `face "${face.id}" list template "${rootId}" contains a TextField. ` +
        'Inputs that write to /$form would collide across list rows. ' +
        'Lift the form out: tap a row to open a Modal with the TextField, then submit.',
      componentId: rootId,
    })
  } else if (caseKey && FORM_BINDING_INPUT_CASES.has(caseKey) && !hasComponentAction(c)) {
    issues.push({
      level: 'error',
      code: 'list-template-input',
      message:
        `face "${face.id}" list template "${rootId}" contains a ${caseKey} without an action. ` +
        'Inputs that write to /$form would collide across list rows. ' +
        'Either set an `action` on the input (fires immediately, no $form write), or lift the input into a Modal opened by tapping the row.',
      componentId: rootId,
    })
  }

  // Recurse through anything this component references by id (children, etc).
  for (const ref of idRefsOf(c)) {
    walkSubtreeForFormInputs(face, ref, byId, issues, visited)
  }
}

// ---------------------------------------------------------------------------
// Policy enforcement (called from FaceRegistry.register)
// ---------------------------------------------------------------------------

/**
 * Apply policy to a face's validation issues: throw an aggregated `Error` for
 * any error-level issues; `console.warn` each warning. The optional `source`
 * label (file path or `"addFace"`/`"hot-reload"`) is included in error
 * messages so authors can trace the failure back to its origin.
 *
 * Splits collection (`validateFaceComponents`) from policy so the validator
 * stays a pure function and dry-run callers (e.g. tests, the LLM
 * validate_face tool) can consume issues without committing to a side
 * effect.
 */
export function enforceFaceValidation(face: FaceDefinition, source = ''): void {
  const prefix = source ? `[${source}] ` : ''
  const issues = validateFaceComponents(face)

  for (const w of issues) {
    if (w.level === 'warning') {
      console.warn(`${prefix}face "${face.id}" ${w.code}: ${w.message}`)
    }
  }

  const errors = issues.filter((i) => i.level === 'error')
  if (errors.length > 0) {
    const lines = errors.map((e) => `  - ${e.code}: ${e.message}`).join('\n')
    throw new Error(`${prefix}face "${face.id}" failed component validation:\n${lines}`)
  }

  // Encode probe — runs even when the graph is clean, because a component can
  // pass graph validation yet fail at wire serialization (most commonly an invalid
  // enum literal, e.g. `body_kind: 'canvas'` → NaN int32). Drafts skip `tsc`, so
  // probing here surfaces the error via validate_face instead of crashing at preview.
  for (const comp of face.components) {
    try {
      toBinary(ComponentDefSchema, comp)
    } catch (err) {
      const cid = (comp as { id?: string }).id ?? '?'
      throw new Error(
        `${prefix}face "${face.id}" component "${cid}" will not serialize: ${err instanceof Error ? err.message : String(err)}. ` +
          `This is usually an invalid enum value (e.g. body_kind must be a BodyKind, not a string).`,
      )
    }
  }
}
