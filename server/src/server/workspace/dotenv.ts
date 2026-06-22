/**
 * Tiny `.env` parser. ~30 LOC; avoids the dotenv dep.
 *
 * Supported syntax:
 *   - `KEY=value`             (unquoted; value is trimmed; trailing `# comment` stripped if preceded by whitespace)
 *   - `KEY="va lue"`          (double-quoted; preserves whitespace, strips surrounding quotes)
 *   - `KEY='va lue'`          (single-quoted; same)
 *   - blank lines + `# comment` lines are ignored
 *   - leading `export ` is tolerated and stripped
 *
 * Limitations (intentional — keep it small):
 *   - No `\n` / `\t` escape handling inside quoted strings.
 *   - No variable expansion (`${OTHER_KEY}`).
 *   - No multiline values.
 */

import fs from 'node:fs'

export type EnvMap = Record<string, string>

/** Parse a `.env` file at `path`. Returns {} if missing. Does NOT touch process.env. */
export function readEnvFile(path: string): EnvMap {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  return parseEnvText(raw)
}

export function parseEnvText(text: string): EnvMap {
  const out: EnvMap = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripExport(rawLine.trim())
    if (line.length === 0 || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq < 1) continue // malformed — skip silently

    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = line.slice(eq + 1).trim()

    // Quoted value: preserve interior whitespace, strip the quote pair only.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    } else {
      // Unquoted: strip a trailing `# comment` only if separated by whitespace.
      const m = value.match(/^(.*?)\s+#.*$/)
      if (m) value = m[1]!.trim()
    }

    out[key] = value
  }
  return out
}

/**
 * Apply env-map values to process.env WITHOUT overwriting existing keys.
 * (Real env vars win; .env only fills gaps.)
 */
export function applyToProcessEnv(map: EnvMap, target: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(map)) {
    if (target[key] === undefined) target[key] = value
  }
}

function stripExport(line: string): string {
  return line.startsWith('export ') ? line.slice(7).trimStart() : line
}
