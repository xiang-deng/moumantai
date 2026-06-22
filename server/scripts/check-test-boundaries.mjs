#!/usr/bin/env node
/**
 * Pre-test boundary check: server tests must not import from `apps/`.
 * `apps/` is a git submodule; importing it couples framework CI to a separate
 * repo. Use the synthetic fixture at `tests/fixtures/test-app/` instead.
 * Wired into the `pretest` npm script (runs before tsc + vitest).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TESTS_ROOT = resolve(__dirname, '../tests')
// Both static imports and dynamic await-import forms are forbidden.
const STATIC_PATTERN = /from\s+['"](?:\.\.\/)+apps\//
const DYNAMIC_PATTERN = /import\s*\(\s*['"](?:\.\.\/)+apps\//
const offenders = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      const text = readFileSync(full, 'utf8')
      const lines = text.split(/\r?\n/)
      lines.forEach((line, i) => {
        if (STATIC_PATTERN.test(line) || DYNAMIC_PATTERN.test(line)) {
          offenders.push(`${full}:${i + 1}: ${line.trim()}`)
        }
      })
    }
  }
}

walk(TESTS_ROOT)

if (offenders.length > 0) {
  console.error('[check-test-boundaries] server tests must not import from `apps/`.')
  console.error('Use the synthetic fixture at tests/fixtures/test-app/ instead.\n')
  for (const line of offenders) console.error('  ' + line)
  process.exit(1)
}
