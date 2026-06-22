/**
 * Cross-renderer conformance: drives the generated TS resolver from
 * `shared/protocol/fixtures/layout-resolution/spec.json`.
 *
 * Single fixture consumed by all five legs (server / web / android / wear / esp32).
 * Each leg calls its language's `resolveChildWidth` / `resolveChildHeight` and
 * asserts the result matches `expected_width` / `expected_height`. Drift in any
 * renderer's resolver or generated table breaks this test.
 *
 * See `shared/protocol/spec.md` rule 10 for the algorithm.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveChildWidth, resolveChildHeight } from '@moumantai/protocol/design-system'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(
  __dirname,
  '../../../../shared/protocol/fixtures/layout-resolution/spec.json',
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Spec

interface Case {
  name: string
  parent_kind: string | null
  slot_index: number
  slot_name: string | null
  child_kind: string
  child_variant: string | null
  own_width_keyword: string | null
  own_height_keyword: string | null
  expected_width: 'fill' | 'wrap' | 'fixed'
  expected_height: 'fill' | 'wrap' | 'fixed'
}
interface Spec {
  version: number
  cases: Array<Case | { $section: string }>
}

function isCase(c: Case | { $section: string }): c is Case {
  return 'name' in c
}

describe('layout-resolution conformance (fixture-driven, TS resolver)', () => {
  for (const c of fixture.cases) {
    if (!isCase(c)) continue
    it(c.name, () => {
      const w = resolveChildWidth(
        c.parent_kind,
        c.slot_index,
        c.slot_name,
        c.child_kind,
        c.child_variant,
        c.own_width_keyword,
      )
      const h = resolveChildHeight(
        c.parent_kind,
        c.slot_index,
        c.slot_name,
        c.child_kind,
        c.child_variant,
        c.own_height_keyword,
      )
      expect(w, `[${c.name}] width`).toBe(c.expected_width)
      expect(h, `[${c.name}] height`).toBe(c.expected_height)
    })
  }
})
