/**
 * defineWidget() helper for authoring reusable, ID-namespaced UI fragments.
 *
 * A widget is a parameterized factory that produces a flat `ComponentDef[]`
 * whose every internal id is prefixed with `${instanceId}__`. Two faces can
 * invoke the same widget with the same instanceId because the renderer's
 * component map is per-face — there is no global namespace to collide in.
 *
 * Limitation: there is no hot-reload watcher for `*.widget.ts` files.
 * Editing a widget requires touching the face entry to trigger reload.
 */

import type { ComponentDef, SizeClass } from '@moumantai/protocol/generated/moumantai/v1'
import { idRefsOf } from './face-validation.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Scope handle passed to a widget's `build()`. Produces namespaced ids. */
export interface WidgetScope {
  /** Returns a scoped id: `${instanceId}__${local}`. */
  id(local: string): string
}

/** Parameter type vocabulary for widget params (mirrors tool params). */
export type WidgetParamType = 'string' | 'number' | 'boolean' | 'pathRef'

/** Spec for one declared param. */
export interface WidgetParamSpec {
  type: WidgetParamType
  required?: boolean
}

/** Author-facing widget specification. */
export interface WidgetSpec<P> {
  /** Logical name for error messages; not part of any id. */
  id: string
  params?: { [K in keyof P]: WidgetParamSpec }
  build: (scope: WidgetScope, params: P, sizeClass?: SizeClass) => ComponentDef[]
}

/** A defined widget — call it with an instanceId + params + sizeClass. */
export type Widget<P> = (instanceId: string, params: P, sizeClass?: SizeClass) => ComponentDef[]

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Local id pattern: identifier-like, no underscores adjacent to namespace. */
const INSTANCE_ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/

const VALID_PARAM_TYPES = new Set<WidgetParamType>(['string', 'number', 'boolean', 'pathRef'])

function checkInstanceId(widgetId: string, instanceId: unknown): asserts instanceId is string {
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new Error(`defineWidget: widget '${widgetId}' invoked with empty instanceId`)
  }
  if (instanceId.includes('__')) {
    throw new Error(
      `defineWidget: widget '${widgetId}' instanceId '${instanceId}' must not contain '__' ` +
        `(reserved as the widget-namespace separator)`,
    )
  }
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(
      `defineWidget: widget '${widgetId}' instanceId '${instanceId}' must match ` +
        `${INSTANCE_ID_RE.source} (start with a letter; letters/digits/underscores only)`,
    )
  }
}

function checkParams<P>(
  widgetId: string,
  paramSpecs: WidgetSpec<P>['params'] | undefined,
  params: P,
): void {
  if (!paramSpecs) return
  const provided = (params ?? {}) as Record<string, unknown>
  for (const [name, spec] of Object.entries(paramSpecs) as [string, WidgetParamSpec][]) {
    if (!VALID_PARAM_TYPES.has(spec.type)) {
      throw new Error(
        `defineWidget: widget '${widgetId}' param '${name}' has invalid type '${spec.type}'. ` +
          `Must be one of: ${[...VALID_PARAM_TYPES].join(', ')}`,
      )
    }
    const value = provided[name]
    const present = value !== undefined
    if (spec.required && !present) {
      throw new Error(`defineWidget: widget '${widgetId}' param '${name}' is required but missing`)
    }
    if (!present) continue
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') {
          throw new Error(
            `defineWidget: widget '${widgetId}' param '${name}' must be a string ` +
              `(got ${typeof value})`,
          )
        }
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(
            `defineWidget: widget '${widgetId}' param '${name}' must be a finite number ` +
              `(got ${typeof value})`,
          )
        }
        break
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(
            `defineWidget: widget '${widgetId}' param '${name}' must be a boolean ` +
              `(got ${typeof value})`,
          )
        }
        break
      case 'pathRef':
        if (typeof value !== 'string' || !value.startsWith('/')) {
          throw new Error(
            `defineWidget: widget '${widgetId}' param '${name}' must be a pathRef string ` +
              `starting with '/' (got ${JSON.stringify(value)})`,
          )
        }
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Define a reusable widget — a parameterized fragment of `ComponentDef[]`
 * whose every internal id is namespaced to a per-instance prefix.
 *
 * ```typescript
 * export const summaryBody = defineWidget<{}>({
 *   id: 'summaryBody',
 *   build: (scope) => [
 *     text(scope.id('total'), pathRef('/summary/total')),
 *   ],
 * })
 *
 * // In a face:
 * components: [
 *   scaffold('root', { body: 'content' }),
 *   column('content', [`summary__total`]),
 *   ...summaryBody('summary', {}),
 * ]
 * ```
 */
export function defineWidget<P>(spec: WidgetSpec<P>): Widget<P> {
  if (!spec.id || typeof spec.id !== 'string') {
    throw new Error('defineWidget: id is required and must be a string')
  }
  if (typeof spec.build !== 'function') {
    throw new Error(`defineWidget: widget '${spec.id}' build is required and must be a function`)
  }

  return function widget(instanceId: string, params: P, sizeClass?: SizeClass): ComponentDef[] {
    checkInstanceId(spec.id, instanceId)
    checkParams(spec.id, spec.params, params)

    const scope: WidgetScope = {
      id: (local: string) => `${instanceId}__${local}`,
    }

    const expansion = spec.build(scope, params, sizeClass)
    if (!Array.isArray(expansion)) {
      throw new Error(
        `defineWidget: widget '${spec.id}' instance '${instanceId}' build() ` +
          `returned ${typeof expansion}, expected ComponentDef[]`,
      )
    }

    // ---- ID uniqueness within the expansion
    const declared = new Set<string>()
    for (const def of expansion) {
      if (!def?.id) continue
      if (declared.has(def.id)) {
        throw new Error(
          `defineWidget: widget '${spec.id}' instance '${instanceId}' has duplicate ` +
            `component id '${def.id}' in expansion`,
        )
      }
      declared.add(def.id)
    }

    // ---- Cross-widget-leak guard
    // Every internal ID-reference must resolve to an id declared inside this
    // widget's expansion. If the build function emitted a bare unscoped id
    // (forgot to call `scope.id()`), the reference will not be in `declared`
    // and we throw — surfacing the bug at definition time, not face-render
    // time. We do NOT silently rewrite refs; the build function owns naming.
    for (const def of expansion) {
      for (const ref of idRefsOf(def)) {
        if (!declared.has(ref)) {
          throw new Error(
            `defineWidget: widget '${spec.id}' instance '${instanceId}' references ` +
              `unknown id '${ref}' (every cross-component reference inside a widget ` +
              `must be produced via scope.id())`,
          )
        }
      }
    }

    // Freeze the array (top-level only) so callers can't mutate the
    // expansion in place. Components are typed proto messages — freezing
    // them would risk breaking proto-internal mutability assumptions.
    return Object.freeze(expansion) as ComponentDef[]
  }
}
