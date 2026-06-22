/**
 * Per-app context loader (LLM-visible preferences).
 *
 * Reads `<home>/apps/<appId>/context.json`, validates against `appDef.context`
 * Zod schema. Defaults fill in missing fields, so adding a new field is a
 * no-op for existing installs. Writes are atomic (write-tmp-rename).
 *
 * Stored as a JSON file rather than a DB row — small structured settings
 * belong in key-value files separate from the app's data DB.
 */

import path from 'node:path'
import fs from 'node:fs'
import { appPaths } from '../workspace/home.js'
import { isZodSchema, readJsonOrEmpty, writeJsonAtomic, validateOrThrow } from './zod-utils.js'

export interface LoadAppContextOptions {
  home: string
  appId: string
  /** Zod schema from AppDefinition.context. May be undefined for apps with no context. */
  schema?: unknown
}

/** Read + validate per-app context from disk. Returns {} when no schema is declared. */
export function loadAppContext(opts: LoadAppContextOptions): Record<string, unknown> {
  if (!isZodSchema(opts.schema)) return {}
  const raw = readJsonOrEmpty(contextFilePath(opts))
  return validateOrThrow<Record<string, unknown>>(opts.appId, 'context', opts.schema, raw)
}

/**
 * Atomically update a single field in context.json. Loads current values,
 * merges, validates, writes. Throws on validation failure (file unchanged).
 * Caller triggers re-resolve of mounted faces (app-engine wires this).
 */
export async function setContextField(
  opts: LoadAppContextOptions,
  field: string,
  value: unknown,
): Promise<void> {
  if (!isZodSchema(opts.schema)) {
    throw new Error(`setContextField: app "${opts.appId}" has no context schema declared`)
  }
  const current = loadAppContext(opts)
  const merged = { ...current, [field]: value }
  const validated = validateOrThrow<Record<string, unknown>>(
    opts.appId,
    'context',
    opts.schema,
    merged,
  )

  const root = appPaths(opts.home, opts.appId).root
  fs.mkdirSync(root, { recursive: true })
  writeJsonAtomic(contextFilePath(opts), validated)
}

/** Replace the whole context object (used by CLI wizard). */
export function saveAppContext(opts: LoadAppContextOptions, values: Record<string, unknown>): void {
  if (!isZodSchema(opts.schema)) return
  const validated = validateOrThrow<Record<string, unknown>>(
    opts.appId,
    'context',
    opts.schema,
    values,
  )
  const root = appPaths(opts.home, opts.appId).root
  fs.mkdirSync(root, { recursive: true })
  writeJsonAtomic(contextFilePath(opts), validated)
}

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

export function contextFilePath(opts: { home: string; appId: string }): string {
  return path.join(appPaths(opts.home, opts.appId).root, 'context.json')
}
