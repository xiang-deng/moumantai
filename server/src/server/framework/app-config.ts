/**
 * Per-app config loader.
 *
 * Reads `<home>/apps/<appId>/config.json` and `<home>/apps/<appId>/.env`,
 * validates against `appDef.config` Zod schema. Fields wrapped in
 * `secretField()` are read from `.env`; the rest from `config.json`.
 *
 * Env-var naming: `<APP_ID_UPPER>_<FIELD_UPPER>` (e.g. `SCOREBOARD_API_KEY`),
 * namespaced per app to prevent collisions.
 */

import fs from 'node:fs'
import path from 'node:path'
import { appPaths } from '../workspace/home.js'
import { readEnvFile } from '../workspace/dotenv.js'
import { isSecretField } from './secret-field.js'
import {
  isZodSchema,
  getObjectFields,
  readJsonOrEmpty,
  writeJsonAtomic,
  validateOrThrow,
} from './zod-utils.js'

export interface LoadAppConfigOptions {
  home: string
  appId: string
  /** Zod schema from AppDefinition.config. May be undefined for apps with no config. */
  schema?: unknown
}

/** Read + validate per-app config from disk. Returns {} when no schema is declared. */
export function loadAppConfig(opts: LoadAppConfigOptions): Record<string, unknown> {
  if (!isZodSchema(opts.schema)) return {}
  const fields = getObjectFields(opts.schema)
  if (!fields) {
    // Non-object schema (e.g. z.record) — validate the whole file.
    return validateOrThrow<Record<string, unknown>>(
      opts.appId,
      'config',
      opts.schema,
      readJsonOrEmpty(configFilePath(opts)),
    )
  }

  const configRaw = readJsonOrEmpty(configFilePath(opts))
  const envMap = readEnvFile(envFilePath(opts))

  // Merge: secret fields from .env, non-secret from config.json.
  const merged: Record<string, unknown> = { ...configRaw }
  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (!isSecretField(fieldSchema)) continue
    const envKey = envKeyFor(opts.appId, name)
    if (envMap[envKey] !== undefined) {
      merged[name] = envMap[envKey]
    }
  }

  return validateOrThrow<Record<string, unknown>>(opts.appId, 'config', opts.schema, merged)
}

/**
 * Validate and persist a config object atomically (used by the CLI wizard).
 * Splits secret fields to `.env`, the rest to `config.json`. `.env` is
 * written with mode 0o600 on Unix; no-op on Windows.
 */
export function saveAppConfig(opts: LoadAppConfigOptions, values: Record<string, unknown>): void {
  if (!isZodSchema(opts.schema)) return
  const fields = getObjectFields(opts.schema)

  const validated = validateOrThrow<Record<string, unknown>>(
    opts.appId,
    'config',
    opts.schema,
    values,
  )

  const root = appPaths(opts.home, opts.appId).root
  fs.mkdirSync(root, { recursive: true })

  if (!fields) {
    writeJsonAtomic(configFilePath(opts), validated)
    return
  }

  const configObj: Record<string, unknown> = {}
  const envMap: Record<string, string> = {}

  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (!(name in validated)) continue
    if (isSecretField(fieldSchema)) {
      envMap[envKeyFor(opts.appId, name)] = String(validated[name])
    } else {
      configObj[name] = validated[name]
    }
  }

  if (Object.keys(configObj).length > 0) {
    writeJsonAtomic(configFilePath(opts), configObj)
  }
  if (Object.keys(envMap).length > 0) {
    writeEnvAtomic(envFilePath(opts), envMap)
  }
}

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

export function configFilePath(opts: { home: string; appId: string }): string {
  return path.join(appPaths(opts.home, opts.appId).root, 'config.json')
}

export function envFilePath(opts: { home: string; appId: string }): string {
  return path.join(appPaths(opts.home, opts.appId).root, '.env')
}

/** Compute env-var key for a secret field. e.g. ('scoreboard', 'api_key') → 'SCOREBOARD_API_KEY'. */
export function envKeyFor(appId: string, fieldName: string): string {
  return `${appId.toUpperCase().replace(/-/g, '_')}_${fieldName.toUpperCase()}`
}

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

/**
 * Write `.env` atomically. Merges with any existing keys in the file so a
 * partial-schema save doesn't wipe values another app or operator put there.
 */
function writeEnvAtomic(filePath: string, env: Record<string, string>): void {
  const existing = readEnvFile(filePath)
  const merged: Record<string, string> = { ...existing, ...env }

  const lines: string[] = []
  for (const [key, value] of Object.entries(merged)) {
    // Quote values containing whitespace or special characters.
    const quoted = /^[A-Za-z0-9_./@:+-]*$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`
    lines.push(`${key}=${quoted}`)
  }
  const text = lines.join('\n') + '\n'
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, text)
  // chmod before rename so the file becomes visible with restrictive perms atomically.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* best-effort */
    }
  }
  fs.renameSync(tmp, filePath)
}
