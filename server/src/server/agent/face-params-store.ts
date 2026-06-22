/**
 * Per-conversation, per-app, per-face view-state store over platform.db's
 * `face_params` table. Used by the synthesized `view_<faceId>` tool (write)
 * and by the agent loop / AppContext builder (read). See `face_params` in
 * `conversations/schema.ts` for lifecycle and FK semantics.
 */

import { and, eq, ne } from 'drizzle-orm'
import type { PlatformDb } from '../db/platform-db.js'
import { faceParams } from '../conversations/schema.js'
import type { FaceDefinition } from './types.js'
import type { FaceRegistry } from './face-loader.js'
import { validateParamsAgainstSchema } from './tool-executor.js'

function effectiveVersion(face: FaceDefinition): number {
  return face.paramsVersion ?? 1
}

/** JSON.parse with object-only `{}` fallback for corrupt or non-object blobs. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export class FaceParamsStore {
  constructor(private readonly db: PlatformDb) {}

  /** Upsert with overwrite semantics. `params = {}` resets to defaults; the row stays. */
  set(
    conversationId: string,
    appId: string,
    faceId: string,
    params: Record<string, unknown>,
    paramsVersion: number,
  ): void {
    const json = JSON.stringify(params)
    this.db
      .insert(faceParams)
      .values({
        conversationId,
        appId,
        faceId,
        params: json,
        paramsVersion,
      })
      .onConflictDoUpdate({
        target: [faceParams.conversationId, faceParams.appId, faceParams.faceId],
        set: { params: json, paramsVersion },
      })
      .run()
  }

  /**
   * Shallow-merge `newParams` into the existing params for the face and
   * return the merged result. Falls back to overwrite (`set`) when no row
   * exists or the stored `paramsVersion` differs from the current one —
   * merging into a stale schema is unsafe.
   *
   * Returns the post-merge bag so callers (the `view_<id>` synthesizer)
   * can pass it to `face.resolve` for an immediate render that reflects
   * the full merged state, not just the input delta.
   *
   * Read-then-write; not transactional. The per-conversation single-threaded
   * agent loop makes last-write-wins acceptable, matching the rest of the
   * persistence layer.
   *
   * Author opts in via `defineFace({ paramsMerge: 'merge' })`.
   */
  setMerged(
    conversationId: string,
    appId: string,
    faceId: string,
    newParams: Record<string, unknown>,
    paramsVersion: number,
  ): Record<string, unknown> {
    const existing = this.get(conversationId, appId, faceId)
    const merged =
      existing && existing.version === paramsVersion
        ? { ...existing.params, ...newParams }
        : newParams
    this.set(conversationId, appId, faceId, merged, paramsVersion)
    return merged
  }

  get(
    conversationId: string,
    appId: string,
    faceId: string,
  ): { params: Record<string, unknown>; version: number } | null {
    const row = this.db
      .select()
      .from(faceParams)
      .where(
        and(
          eq(faceParams.conversationId, conversationId),
          eq(faceParams.appId, appId),
          eq(faceParams.faceId, faceId),
        ),
      )
      .get()
    if (!row) return null
    return { params: safeParse(row.params), version: row.paramsVersion }
  }

  clear(conversationId: string, appId: string, faceId: string): void {
    this.db
      .delete(faceParams)
      .where(
        and(
          eq(faceParams.conversationId, conversationId),
          eq(faceParams.appId, appId),
          eq(faceParams.faceId, faceId),
        ),
      )
      .run()
  }

  getAll(
    conversationId: string,
    appId: string,
  ): Record<string, { params: Record<string, unknown>; version: number }> {
    const rows = this.db
      .select()
      .from(faceParams)
      .where(and(eq(faceParams.conversationId, conversationId), eq(faceParams.appId, appId)))
      .all()
    const out: Record<string, { params: Record<string, unknown>; version: number }> = {}
    for (const row of rows) {
      out[row.faceId] = { params: safeParse(row.params), version: row.paramsVersion }
    }
    return out
  }

  /** Per-turn entry point: validate stored rows against current schema, drop stale ones, return faceId → params. */
  validateAndLoad(
    conversationId: string,
    appId: string,
    registry: FaceRegistry,
  ): Record<string, Record<string, unknown>> {
    const rows = this.getAll(conversationId, appId)
    const out: Record<string, Record<string, unknown>> = {}
    for (const [faceId, { params, version }] of Object.entries(rows)) {
      const face = registry.get(faceId)
      if (!face || !face.params) {
        this.clear(conversationId, appId, faceId)
        console.warn(
          `[face-params] dropped stale row: face "${faceId}" not found or no longer parameterized`,
          { appId, conversationId, faceId },
        )
        continue
      }
      if (version !== effectiveVersion(face)) {
        this.clear(conversationId, appId, faceId)
        console.warn(
          `[face-params] dropped stale row: paramsVersion mismatch (stored=${version}, current=${effectiveVersion(face)})`,
          { appId, conversationId, faceId },
        )
        continue
      }
      const validationError = validateParamsAgainstSchema(face.params, params)
      if (validationError !== null) {
        this.clear(conversationId, appId, faceId)
        console.warn(
          `[face-params] dropped stale row: schema validation failed (${validationError})`,
          { appId, conversationId, faceId },
        )
        continue
      }
      out[faceId] = params
    }
    return out
  }

  /** Drop every row whose stored paramsVersion doesn't match the current face — eager cleanup on `paramsVersion` bumps. */
  sweepStaleVersions(appId: string, registry: FaceRegistry): number {
    let dropped = 0
    for (const face of registry.list()) {
      if (!face.params) continue
      const result = this.db
        .delete(faceParams)
        .where(
          and(
            eq(faceParams.appId, appId),
            eq(faceParams.faceId, face.id),
            ne(faceParams.paramsVersion, effectiveVersion(face)),
          ),
        )
        .run()
      const changed = (result as { changes?: number }).changes ?? 0
      if (changed > 0) {
        console.warn(
          `[face-params] swept ${changed} stale row(s) for face "${face.id}" (current version=${effectiveVersion(face)})`,
          { appId },
        )
        dropped += changed
      }
    }
    return dropped
  }

  deleteByApp(appId: string): number {
    const result = this.db.delete(faceParams).where(eq(faceParams.appId, appId)).run()
    return (result as { changes?: number }).changes ?? 0
  }
}
