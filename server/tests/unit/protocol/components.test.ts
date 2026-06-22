/**
 * SDK-logic tests — covers hand-written rules inside component builders that are
 * NOT structurally guaranteed by codegen + tsc:
 *   1. The `'grow'` keyword rewrites to `weight: 1` and clears width/height.
 *   2. Empty-string positional input defaults to `pathRef('/$form/<id>')`.
 *   3. Builders omit the modifier sub-message when no modifier props are set.
 *
 * Codegen-guaranteed passthrough is not tested here — it would be tautological.
 * The SDK options factory is derived from ComponentDefSchema and enforced by
 * `apps:typecheck` at compile time.
 */

import { describe, it, expect } from 'vitest'
import {
  box,
  tabs,
  text,
  textField,
  select,
  dateTimeInput,
  invokeTool,
} from '../../../src/server/protocol/components'
import type {
  BoxComponent,
  TextComponent,
  TextFieldComponent,
} from '@moumantai/protocol/generated/moumantai/v1'

// ---------------------------------------------------------------------------
// The `'grow'` keyword is authoring shorthand for `weight: 1` — the SDK
// rewrites it at build time so renderers only ever see the canonical numeric
// weight. Hand-written rule; not codegen-derived.
// ---------------------------------------------------------------------------

describe('grow keyword → weight rewrite', () => {
  it('width: "grow" rewrites to weight: 1 and clears width', () => {
    const def = box('b', [], { width: 'grow' })
    const v = def.component.value as BoxComponent
    expect(v.modifier?.weight).toBe(1)
    expect(v.modifier?.width).toBeUndefined()
  })

  it('height: "grow" rewrites to weight: 1 and clears height', () => {
    const def = box('b', [], { height: 'grow' })
    const v = def.component.value as BoxComponent
    expect(v.modifier?.weight).toBe(1)
    expect(v.modifier?.height).toBeUndefined()
  })

  it('explicit weight wins over width: "grow"', () => {
    const def = box('b', [], { width: 'grow', weight: 2 })
    const v = def.component.value as BoxComponent
    expect(v.modifier?.weight).toBe(2)
    expect(v.modifier?.width).toBeUndefined()
  })

  it('width + height both "grow" produce a single weight: 1', () => {
    const def = box('b', [], { width: 'grow', height: 'grow' })
    const v = def.component.value as BoxComponent
    expect(v.modifier?.weight).toBe(1)
    expect(v.modifier?.width).toBeUndefined()
    expect(v.modifier?.height).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Empty-string positional `value` used to defeat the default `/$form/<id>`
// binding because `value ?? defaultFormPath(id)` doesn't trigger on `''`.
// Field would re-read literal `''` on every recomposition and clobber
// keystrokes. See shared/protocol/FORM_SCOPE.md.
// ---------------------------------------------------------------------------

describe('input default form-binding', () => {
  it('textField defaults value to /$form/<id>', () => {
    const def = textField('name')
    const v = def.component.value as TextFieldComponent
    expect(v.value?.value).toEqual({ case: 'path', value: '/$form/name' })
  })

  it.each([
    ['textField', (id: string) => textField(id, '', 'L')],
    ['select', (id: string) => select(id, '', 'L')],
    ['dateTimeInput', (id: string) => dateTimeInput(id, '', 'L')],
  ])('%s treats empty-string value as nullish (default $form binding)', (_name, build) => {
    const def = build('x')
    const v = def.component.value as { value?: { value: { case: string; value: string } } }
    expect(v.value?.value).toEqual({ case: 'path', value: '/$form/x' })
  })

  it('textField honors a non-empty literal value (no override of explicit binding)', () => {
    const def = textField('name', 'Alice', 'Label')
    const v = def.component.value as TextFieldComponent
    expect(v.value?.value).toEqual({ case: 'literal', value: 'Alice' })
  })

  it('tabs defaults selected to /$form/<id> when no action', () => {
    const def = tabs('view', ['A', 'B'])
    const v = def.component.value as { selected?: { value: { case: string; value: string } } }
    expect(v.selected?.value).toEqual({ case: 'path', value: '/$form/view' })
  })

  it('tabs leaves selected undefined when action is set (Mode A)', () => {
    const def = tabs('view', ['A', 'B'], ['c0', 'c1'], { action: invokeTool('navigate_to') })
    const v = def.component.value as { selected?: unknown }
    expect(v.selected).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Builders omit the modifier sub-message entirely when no modifier props are
// set. Prevents wire bloat from empty {} payloads.
// ---------------------------------------------------------------------------

describe('modifier omission', () => {
  it('omits the modifier sub-message when no modifier props are set', () => {
    const def = text('t', 'Hello')
    const v = def.component.value as TextComponent
    expect(v.modifier).toBeUndefined()
  })
})
