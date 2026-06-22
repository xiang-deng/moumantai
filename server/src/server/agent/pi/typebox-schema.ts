/**
 * Moumantai `ToolParameter` map → TypeBox `TObject` schema.
 *
 * Pi's `defineTool({ parameters })` expects a TypeBox schema (Pi compiles it
 * to JSON-Schema for the underlying provider). This is the TypeBox sibling
 * of `claude/adapter.ts:buildZodSchema`. Same input shape; different output
 * library.
 */

import { Type, type Static, type TObject, type TSchema } from 'typebox'
import type { ToolParameter } from '../types.js'

/**
 * Build a TypeBox object schema from a Moumantai parameter map. Required
 * params land in the object's required set; optional ones get `Type.Optional`.
 * Description metadata is preserved so the LLM sees per-param hints.
 *
 * Throws on unsupported types — keeps Moumantai's three primitives the
 * source of truth; if we expand `ToolParameter.type`, this is the second
 * place to update (the first being `buildZodSchema`).
 */
export function buildTypeBoxSchema(parameters: Record<string, ToolParameter>): TObject {
  const properties: Record<string, TSchema> = {}
  for (const [name, param] of Object.entries(parameters)) {
    let base: TSchema
    switch (param.type) {
      case 'string':
        base = param.description ? Type.String({ description: param.description }) : Type.String()
        break
      case 'number':
        base = param.description ? Type.Number({ description: param.description }) : Type.Number()
        break
      case 'boolean':
        base = param.description ? Type.Boolean({ description: param.description }) : Type.Boolean()
        break
      default:
        throw new Error(
          `buildTypeBoxSchema: unsupported type "${(param as { type?: unknown }).type}" on param "${name}"`,
        )
    }
    properties[name] = param.required ? base : Type.Optional(base)
  }
  return Type.Object(properties)
}

// Re-export Static so callers using buildTypeBoxSchema can derive runtime
// types from the returned TObject without a separate typebox import.
export type { Static }
