/**
 * Face Registry
 *
 * Manages registered face definitions for an app.
 * Calls each face's resolve() function to produce nested data.
 *
 * `register()` and `registerVariant()` validate the incoming face's component
 * graph via `enforceFaceValidation` — this is the single choke point every
 * face passes through (static load, draft-agent edits, hot-reload), so any
 * dangling-ref / duplicate-id / missing-root error fails loudly at the entry
 * point instead of producing a silently-blank render later.
 */

import type { FaceDefinition, StalenessRecord } from './types.js'
import { SizeClass } from '@moumantai/protocol/generated/moumantai/v1'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { enforceFaceValidation } from './face-validation.js'

export interface FaceResolveDeps {
  db: BetterSQLite3Database
  /**
   * Per-face view-state, keyed by faceId. Faces without a row receive `{}`.
   * Resolvers fill defaults via `params.x ?? fallback()`.
   *
   * Optional — when absent, every face receives `{}` for params (test convenience).
   */
  paramsByFaceId?: Record<string, Record<string, unknown>>
  /**
   * Per-task staleness factory. Threaded into `resolve` so faces can compose
   * freshness affordances (e.g. "Updated 4s ago"). Optional — when absent,
   * resolvers either skip the affordance or fall back to defaults.
   */
  staleness?: (taskId: string) => StalenessRecord
  /**
   * Lookup for face-bound staleness — given (faceId, params), returns a
   * StalenessRecord or null. Used by the framework to construct
   * `selfStaleness?()` on FaceResolve ctx; resolvers see only the
   * parameter-less thunk. Optional — when omitted, resolvers receive
   * undefined for `selfStaleness`.
   */
  faceStaleness?: (faceId: string, params: Record<string, unknown>) => StalenessRecord | null
  /**
   * LLM-visible app preferences. Same object boot loaded into
   * `BootedApp.context`. Threaded into `resolve` so default-from-preference
   * logic (e.g. default league on the scoreboard face) is shared with the
   * tool path. Optional — resolvers tolerate omission via `?? fallback()`.
   */
  context?: Record<string, unknown>
}

/** Reserved data-tree key where the framework injects resolved view-state.
 * Components read current view-state via `pathRef('/$params/<key>')`. */
const PARAMS_DATA_KEY = '$params'

/** Optional source-label and validation toggle for register paths. */
export interface RegisterOpts {
  /** Source label included in validation error messages (e.g. file path). */
  source?: string
  /**
   * Skip validation. Reserved for tests that intentionally feed broken faces;
   * production callers should always validate. Default false (always validate).
   */
  skipValidation?: boolean
}

/** A face with optional per-sizeClass variants. */
export interface FaceVariantSet {
  default: FaceDefinition
  variants: Partial<Record<SizeClass, FaceDefinition>>
}

export class FaceRegistry {
  private faces = new Map<string, FaceVariantSet>()

  /** Register a face definition. If a face with the same id exists, merges as default. */
  register(face: FaceDefinition, opts: RegisterOpts = {}): void {
    if (!opts.skipValidation) enforceFaceValidation(face, opts.source)
    const existing = this.faces.get(face.id)
    if (existing) {
      existing.default = face
    } else {
      this.faces.set(face.id, { default: face, variants: {} })
    }
  }

  /** Register a face variant for a specific sizeClass. */
  registerVariant(
    faceId: string,
    sizeClass: SizeClass,
    face: FaceDefinition,
    opts: RegisterOpts = {},
  ): void {
    if (!opts.skipValidation) enforceFaceValidation(face, opts.source)
    const existing = this.faces.get(faceId)
    if (existing) {
      existing.variants[sizeClass] = face
    } else {
      // Variant without a default — use it as default too
      this.faces.set(faceId, { default: face, variants: { [sizeClass]: face } })
    }
  }

  /** Remove a face by id. Returns true if it existed. */
  remove(faceId: string): boolean {
    return this.faces.delete(faceId)
  }

  /** Get the default face definition by id. */
  get(faceId: string): FaceDefinition | undefined {
    return this.faces.get(faceId)?.default
  }

  /** Select the best face variant for a sizeClass, falling back to default. */
  selectForSize(faceId: string, sizeClass: SizeClass): FaceDefinition {
    const set = this.faces.get(faceId)
    if (!set) {
      console.warn(`[face] selectForSize: unknown face "${faceId}"`)
      return { id: faceId, label: '', position: 0, components: [], resolve: () => ({}) }
    }
    return set.variants[sizeClass] ?? set.default
  }

  /** List all registered faces (default variant), sorted by position. */
  list(): FaceDefinition[] {
    return [...this.faces.values()].map((s) => s.default).sort((a, b) => a.position - b.position)
  }

  /** Number of registered face ids. */
  get size(): number {
    return this.faces.size
  }

  /**
   * Run the default variant's resolver for a single face.
   * All size variants share one resolver (data is the same; only layout differs).
   * The framework merges params at `data.$params` so components can bind via
   * `pathRef('/$params/<key>')` — authors don't need to include params explicitly.
   */
  resolveOne(faceId: string, deps: FaceResolveDeps): Record<string, unknown> {
    const face = this.faces.get(faceId)?.default
    if (!face) return {}
    const params = deps.paramsByFaceId?.[faceId] ?? {}
    const selfStaleness =
      face.refresh && deps.faceStaleness ? () => deps.faceStaleness!(faceId, params) : undefined
    try {
      const data = face.resolve({
        db: deps.db,
        params,
        staleness: deps.staleness,
        context: deps.context,
        ...(selfStaleness ? { selfStaleness } : {}),
      })
      // Auto-inject $params (overrides anything the resolver set under that key
      // — reserved name; authors should not write to it).
      return { ...data, [PARAMS_DATA_KEY]: params }
    } catch (err) {
      console.error(`[face] resolve error for "${faceId}":`, err)
      // Even on error, surface params so the LLM/UI sees current view state.
      return { [PARAMS_DATA_KEY]: params }
    }
  }

  /**
   * Run resolve for all faces (default variants).
   * Returns a Map of faceId → nested data (with `$params` merged in).
   */
  resolveAll(deps: FaceResolveDeps): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>()
    for (const [faceId, set] of this.faces) {
      const params = deps.paramsByFaceId?.[faceId] ?? {}
      const face = set.default
      const selfStaleness =
        face.refresh && deps.faceStaleness ? () => deps.faceStaleness!(faceId, params) : undefined
      try {
        const data = face.resolve({
          db: deps.db,
          params,
          staleness: deps.staleness,
          context: deps.context,
          ...(selfStaleness ? { selfStaleness } : {}),
        })
        result.set(faceId, { ...data, [PARAMS_DATA_KEY]: params })
      } catch (err) {
        console.error(`[face] resolve error for "${faceId}":`, err)
        result.set(faceId, { [PARAMS_DATA_KEY]: params })
      }
    }
    return result
  }
}
