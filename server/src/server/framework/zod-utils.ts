/**
 * Shared Zod + JSON-file helpers used by app-config, app-context, and
 * synthesize-update-context-tool.
 */

import fs from 'node:fs'
import type { ZodType } from 'zod'

/**
 * True when `value` looks like a Zod schema (has `.safeParse`). Narrows the
 * `unknown` schema fields on AppDefinition (kept `unknown` to keep types.ts
 * framework-pure).
 */
export function isZodSchema(value: unknown): value is ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  )
}

/**
 * Extract `.shape` from a `ZodObject`. Returns null for non-object schemas
 * (e.g., `z.record(...)`). Callers fall back to validating the whole value
 * in that case.
 */
export function getObjectFields(schema: ZodType): Record<string, ZodType> | null {
  const s = schema as { shape?: Record<string, ZodType> | (() => Record<string, ZodType>) }
  if (typeof s.shape === 'function') {
    try {
      const result = s.shape()
      return result && typeof result === 'object' ? result : null
    } catch {
      return null
    }
  }
  if (s.shape && typeof s.shape === 'object') {
    return s.shape as Record<string, ZodType>
  }
  return null
}

/** Read JSON file as `Record<string, unknown>`; return `{}` for missing file or non-object content. */
export function readJsonOrEmpty(filePath: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`)
    }
    throw err
  }
}

/** Write JSON atomically (write to .tmp, then rename). Survives mid-write crashes. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + '\n'
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, filePath)
}

/**
 * `safeParse` against a Zod schema; throws with a path-and-message error for
 * boot-time diagnostics. `kind` label distinguishes 'config' vs 'context'.
 */
export function validateOrThrow<T = unknown>(
  appId: string,
  kind: 'config' | 'context',
  schema: ZodType,
  raw: unknown,
): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid app ${kind} for "${appId}":\n${issues}`)
  }
  return result.data as T
}
