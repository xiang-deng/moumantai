/**
 * Synthesizes an `update_context` tool from an app's `context` Zod schema.
 *
 * Every app with a non-empty `context` schema gets one synthesized tool:
 *
 *   update_context({ field: string, value: string }) → { ok, updated }
 *
 * The tool description enumerates available fields and their types from the
 * schema so the LLM knows what's settable. Execute path parses the string
 * value to the field's expected type, validates via setContext (which
 * Zod-validates the merged context), and writes atomically.
 *
 * Per design Decision 4 review: app context is the LLM-visible tier; this
 * tool is the LLM's editing affordance ("user said 'I prefer NBA'" →
 * update_context({field: 'default_league', value: 'nba'})).
 */

import type { ToolDefinition, ToolContext } from './types.js'
import type { ZodType } from 'zod'
import { isZodSchema, getObjectFields } from '../framework/zod-utils.js'

export interface SynthesizeOptions {
  appId: string
  /** Zod schema from AppDefinition.context. Undefined → no synthesis. */
  contextSchema?: unknown
  /** Setter that writes to context.json with validation. */
  setContext: (field: string, value: unknown) => Promise<void>
}

/**
 * Returns the synthesized `update_context` tool, or null if the app has no
 * context schema (or its schema describes no fields).
 */
export function synthesizeUpdateContextTool(opts: SynthesizeOptions): ToolDefinition | null {
  if (!isZodSchema(opts.contextSchema)) return null
  const fields = getObjectFields(opts.contextSchema)
  if (!fields || Object.keys(fields).length === 0) return null

  const description = buildDescription(fields)

  return Object.freeze({
    name: 'update_context',
    description,
    parameters: {
      field: {
        type: 'string',
        required: true,
        description: `The preference field name. Available: ${Object.keys(fields).join(', ')}.`,
      },
      value: {
        type: 'string',
        required: true,
        description: 'The new value as a string (will be coerced to the field type).',
      },
    },
    execute: async ({ params }: ToolContext) => {
      const field = typeof params.field === 'string' ? params.field : ''
      if (!field) {
        return { result: null, error: 'field is required' }
      }
      const fieldSchema = fields[field]
      if (!fieldSchema) {
        return {
          result: null,
          error: `unknown field "${field}"; available: ${Object.keys(fields).join(', ')}`,
        }
      }

      const coerced = coerceValue(params.value, fieldSchema)
      try {
        await opts.setContext(field, coerced)
        return { result: { ok: true, updated: { field, value: coerced } } }
      } catch (err) {
        return {
          result: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }) as ToolDefinition
}

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

/** Build a description listing each field and its parsed type / allowed values. */
function buildDescription(fields: Record<string, ZodType>): string {
  const lines: string[] = []
  lines.push(
    'Update an LLM-visible app preference. Call when the user expresses a preference (e.g., "I prefer NBA"). Available fields:',
  )
  for (const [name, fieldSchema] of Object.entries(fields)) {
    lines.push(`  - ${name}: ${describeFieldType(fieldSchema)}`)
  }
  return lines.join('\n')
}

/** Best-effort human-readable type description from a Zod field. */
function describeFieldType(schema: ZodType): string {
  const ctor = (schema.constructor as { name?: string }).name ?? 'Unknown'
  // Zod v4 introspection — ZodEnum has `.options`/`.values`; wrappers expose `_def.innerType`.
  const def = (schema as { _def?: unknown })._def as Record<string, unknown> | undefined

  // ZodOptional / ZodNullable: prefix the inner type description.
  if (ctor === 'ZodOptional' || ctor === 'ZodNullable') {
    const inner = def && 'innerType' in def ? (def['innerType'] as ZodType) : null
    if (inner) {
      const prefix = ctor === 'ZodOptional' ? 'optional ' : 'nullable '
      return `${prefix}${describeFieldType(inner)}`
    }
  }

  // ZodDefault: describe inner with a default annotation.
  if (ctor === 'ZodDefault' && def && 'innerType' in def) {
    const inner = def['innerType'] as ZodType
    if (inner) {
      const innerDesc = describeFieldType(inner)
      const defVal = 'defaultValue' in def ? def['defaultValue'] : undefined
      const defStr = typeof defVal === 'function' ? (defVal as () => unknown)() : defVal
      return `${innerDesc} (default: ${JSON.stringify(defStr)})`
    }
  }

  // ZodEnum: list allowed values from `_def.values`.
  if (def && 'values' in def) {
    const values = def['values']
    if (Array.isArray(values))
      return `enum (one of: ${values.map((v) => JSON.stringify(v)).join(', ')})`
    if (values && typeof values === 'object') {
      return `enum (one of: ${Object.values(values)
        .map((v) => JSON.stringify(v))
        .join(', ')})`
    }
  }

  switch (ctor) {
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodEnum':
      return 'enum'
    default:
      return ctor.replace(/^Zod/, '').toLowerCase()
  }
}

/** Coerce a raw value (typically a string from the LLM) to the field's expected type. */
function coerceValue(raw: unknown, schema: ZodType): unknown {
  // First attempt: pass-through. If it parses, we're done.
  const passthrough = schema.safeParse(raw)
  if (passthrough.success) return passthrough.data

  // Otherwise: if raw is a string, try common coercions.
  if (typeof raw === 'string') {
    // boolean
    if (raw === 'true') {
      const r = schema.safeParse(true)
      if (r.success) return r.data
    }
    if (raw === 'false') {
      const r = schema.safeParse(false)
      if (r.success) return r.data
    }
    // number
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      const num = Number(raw)
      const r = schema.safeParse(num)
      if (r.success) return r.data
    }
  }

  // Return raw — setContext's safeParse will fail and surface a clear error.
  return raw
}
