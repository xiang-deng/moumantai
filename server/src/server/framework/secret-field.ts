/**
 * `secretField()` — Zod brand for routing fields to .env vs config.json.
 *
 * App `config` schemas declare technical setup. Most fields go to
 * `~/.moumantai/apps/<id>/config.json`. Fields wrapped in `secretField()`
 * are routed to `~/.moumantai/apps/<id>/.env` and never appear in
 * `AppContext` (so they're hidden from the LLM by construction).
 *
 * ```typescript
 * import { z } from 'zod'
 * import { secretField } from 'moumantai'
 *
 * export const config = z.object({
 *   default_endpoint: z.string().default('https://api.example.com'),
 *   api_key: secretField(z.string().min(1)),
 * })
 * ```
 *
 * Implementation: a Zod `.brand<...>()` mark plus a sentinel description
 * prefix the loader inspects. Brand keeps the type narrow; description
 * sentinel makes runtime detection cheap (no schema introspection).
 */

import type { ZodType } from 'zod'

const SECRET_BRAND = Symbol('moumantai.secretField')

const SECRET_DESC_PREFIX = '__moumantai_secret__'

export type SecretField<T extends ZodType> = T & { readonly [SECRET_BRAND]: true }

/**
 * Mark a Zod field as a secret. The framework will:
 *   1. Route reads/writes to `<home>/apps/<id>/.env` rather than `config.json`
 *   2. Strip the value from `AppContext` (hidden from LLM by construction)
 *   3. Redact during CLI prompts (input not echoed)
 */
export function secretField<T extends ZodType>(schema: T): SecretField<T> {
  const desc = schema.description ?? ''
  const newDesc = desc.startsWith(SECRET_DESC_PREFIX) ? desc : `${SECRET_DESC_PREFIX}${desc}`
  // Zod's .describe() returns a new instance with the description set.
  const branded = schema.describe(newDesc) as unknown as SecretField<T>
  return branded
}

/** True if this field was wrapped by `secretField()`. Used by app-config loader. */
export function isSecretField(schema: ZodType): boolean {
  const desc = (schema as { description?: string }).description
  return typeof desc === 'string' && desc.startsWith(SECRET_DESC_PREFIX)
}

/** Strip the sentinel for human-readable display (CLI prompts, errors). */
export function getSecretFieldDescription(schema: ZodType): string {
  const desc = (schema as { description?: string }).description ?? ''
  return desc.startsWith(SECRET_DESC_PREFIX) ? desc.slice(SECRET_DESC_PREFIX.length) : desc
}
