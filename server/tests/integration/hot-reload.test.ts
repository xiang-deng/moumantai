/**
 * Integration: hot-reload — entry edits reload, transitive file edits do not.
 * Runs in a `node` subprocess to exercise the production module cache.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tempDirs = []
})

function createApp(initialParts: string, initialEntrySuffix = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'moumantai-hotreload-'))
  tempDirs.push(dir)
  writeFileSync(
    join(dir, 'index.mjs'),
    `export { value } from './parts.mjs'\nexport const stamp = 'v0'${initialEntrySuffix}\n`,
  )
  writeFileSync(join(dir, 'parts.mjs'), initialParts)
  return dir
}

function reloadCycle(args: {
  dir: string
  beforeParts?: string
  afterParts?: string
  beforeIndex?: string
  afterIndex?: string
}): { first: { value: string; stamp: string }; second: { value: string; stamp: string } } {
  const indexUrl = pathToFileURL(join(args.dir, 'index.mjs')).href
  const partsPath = join(args.dir, 'parts.mjs')
  const indexPath = join(args.dir, 'index.mjs')
  const script = `
    import { writeFileSync } from 'node:fs'
    ${args.beforeParts ? `writeFileSync(${JSON.stringify(partsPath)}, ${JSON.stringify(args.beforeParts)})` : ''}
    ${args.beforeIndex ? `writeFileSync(${JSON.stringify(indexPath)}, ${JSON.stringify(args.beforeIndex)})` : ''}
    const m1 = await import(${JSON.stringify(indexUrl)} + '?v=1')
    ${args.afterParts ? `writeFileSync(${JSON.stringify(partsPath)}, ${JSON.stringify(args.afterParts)})` : ''}
    ${args.afterIndex ? `writeFileSync(${JSON.stringify(indexPath)}, ${JSON.stringify(args.afterIndex)})` : ''}
    const m2 = await import(${JSON.stringify(indexUrl)} + '?v=2')
    process.stdout.write(JSON.stringify({
      first: { value: String(m1.value), stamp: String(m1.stamp) },
      second: { value: String(m2.value), stamp: String(m2.stamp) },
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) {
    throw new Error(`node subprocess failed (status ${result.status}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout.trim())
}

describe('hot-reload: transitive cache (subprocess)', () => {
  it('entry edit re-evaluates exports on next ?v=<t> import', () => {
    const dir = createApp(`export const value = 'unchanged'\n`)
    const { first, second } = reloadCycle({
      dir,
      beforeIndex: `export { value } from './parts.mjs'\nexport const stamp = 'v0'\n`,
      afterIndex: `export { value } from './parts.mjs'\nexport const stamp = 'v1'\n`,
    })
    expect(first.stamp).toBe('v0')
    expect(second.stamp).toBe('v1')
  })

  it('transitive edit is NOT picked up — child URL stays cached', () => {
    const dir = createApp(`export const value = 'before'\n`)
    const { first, second } = reloadCycle({
      dir,
      beforeParts: `export const value = 'before'\n`,
      afterParts: `export const value = 'after'\n`,
    })
    expect(first.value).toBe('before')
    // The second import re-evaluates index.mjs (?v=2) but `import './parts.mjs'`
    // resolves to the unversioned URL still in cache. Touch index.mjs or restart
    // to pick up transitive edits. Documented in server/CLAUDE.md.
    expect(second.value).toBe('before')
  })
})
