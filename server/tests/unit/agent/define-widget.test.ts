/**
 * Unit tests for defineWidget().
 *
 * Uses real component builders so assertions exercise the actual ComponentDef
 * shape. The end-to-end describe plugs a widget into a face and runs
 * `validateFaceComponents` to prove the post-pass is faithful to the validator.
 */

import { describe, it, expect } from 'vitest'
import {
  scaffold,
  column,
  card,
  text,
  list,
  listItem,
  pathRef,
} from '../../../src/server/protocol/components/index.js'
import { defineFace } from '../../../src/server/agent/define-face.js'
import { defineWidget, type WidgetScope } from '../../../src/server/agent/define-widget.js'
import { validateFaceComponents } from '../../../src/server/agent/face-validation.js'

// ---------------------------------------------------------------------------
// Happy path — namespace isolation
// ---------------------------------------------------------------------------

describe('defineWidget — happy path', () => {
  // A minimal widget: a Card containing a Text, both ids prefixed.
  const tinyCard = defineWidget<{ label: string }>({
    id: 'tinyCard',
    params: { label: { type: 'string', required: true } },
    build: (scope: WidgetScope, params) => [
      card(scope.id('root'), [scope.id('title')]),
      text(scope.id('title'), params.label),
    ],
  })

  it('produces ids prefixed with the instanceId__ namespace', () => {
    const exp = tinyCard('a', { label: 'A' })
    const ids = exp.map((c) => c.id)
    expect(ids).toEqual(['a__root', 'a__title'])
  })

  it('two instances of the same widget produce non-colliding ids', () => {
    const a = tinyCard('a', { label: 'A' })
    const b = tinyCard('b', { label: 'B' })
    const ids = [...a, ...b].map((c) => c.id)
    expect(ids).toEqual(['a__root', 'a__title', 'b__root', 'b__title'])
    expect(new Set(ids).size).toBe(ids.length) // no collisions
  })

  it('passes through sizeClass to build()', () => {
    const observed: unknown[] = []
    const w = defineWidget<{}>({
      id: 'sizeAware',
      build: (scope, _params, sizeClass) => {
        observed.push(sizeClass)
        return [text(scope.id('t'), 'x')]
      },
    })
    w('a', {}, /* SizeClass.COMPACT */ 1 as unknown as number)
    expect(observed).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

describe('defineWidget — param validation', () => {
  const labeled = defineWidget<{ label: string; count?: number }>({
    id: 'labeled',
    params: {
      label: { type: 'string', required: true },
      count: { type: 'number' },
    },
    build: (scope) => [text(scope.id('t'), 'x')],
  })

  it('throws with widget id + param name when required param is missing', () => {
    let err: Error | undefined
    try {
      labeled('a', {} as { label: string })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'labeled'")
    expect(err!.message).toContain("param 'label'")
    expect(err!.message).toMatch(/required/)
  })

  it('throws with widget id + param name when type is wrong', () => {
    let err: Error | undefined
    try {
      labeled('a', { label: 42 as unknown as string })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'labeled'")
    expect(err!.message).toContain("param 'label'")
    expect(err!.message).toMatch(/string/)
  })

  it('accepts optional params when omitted', () => {
    expect(() => labeled('a', { label: 'ok' })).not.toThrow()
  })

  it('rejects non-finite numbers', () => {
    let err: Error | undefined
    try {
      labeled('a', { label: 'ok', count: Number.NaN })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("param 'count'")
    expect(err!.message).toMatch(/finite number/)
  })

  it('pathRef param must start with /', () => {
    const w = defineWidget<{ src: string }>({
      id: 'pathy',
      params: { src: { type: 'pathRef', required: true } },
      build: (scope) => [text(scope.id('t'), 'x')],
    })
    let err: Error | undefined
    try {
      w('a', { src: 'not-a-path' })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'pathy'")
    expect(err!.message).toContain("param 'src'")
    expect(err!.message).toMatch(/pathRef/)
    // valid path passes
    expect(() => w('a', { src: '/foo/bar' })).not.toThrow()
  })

  it('rejects unknown param type at definition time', () => {
    const w = defineWidget<{ x: unknown }>({
      id: 'broken',
      params: { x: { type: 'date' as unknown as 'string', required: true } },
      build: (scope) => [text(scope.id('t'), 'x')],
    })
    let err: Error | undefined
    try {
      w('a', { x: 1 })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'broken'")
    expect(err!.message).toContain("param 'x'")
    expect(err!.message).toMatch(/invalid type 'date'/)
  })
})

// ---------------------------------------------------------------------------
// instanceId validation
// ---------------------------------------------------------------------------

describe('defineWidget — instanceId validation', () => {
  const noop = defineWidget<{}>({
    id: 'noop',
    build: (scope) => [text(scope.id('t'), 'x')],
  })

  it.each([
    ['', /empty instanceId/],
    ['foo__bar', /'__'/],
    ['1bad', /start with a letter/],
    ['has-dash', /has-dash/],
  ] as [string, RegExp][])('throws on invalid instanceId (%s)', (id, msgPattern) => {
    let err: Error | undefined
    try {
      noop(id, {})
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'noop'")
    expect(err!.message).toMatch(msgPattern)
  })

  it('accepts identifier-like instanceIds with single underscores', () => {
    expect(() => noop('summary_main', {})).not.toThrow()
    expect(() => noop('a1', {})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Cross-widget leak guard
// ---------------------------------------------------------------------------

describe('defineWidget — cross-widget leak guard', () => {
  it('throws when build() references an unscoped (external) id', () => {
    // 'external_id' is not prefixed via scope.id() — a namespace leak the post-pass must catch.
    const leaky = defineWidget<{}>({
      id: 'leaky',
      build: (scope) => [
        column(scope.id('root'), ['external_id']), // <- forgot scope.id()
        text(scope.id('child'), 'x'),
      ],
    })
    let err: Error | undefined
    try {
      leaky('a', {})
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'leaky'")
    expect(err!.message).toContain("instance 'a'")
    expect(err!.message).toContain("'external_id'")
    expect(err!.message).toMatch(/scope\.id\(\)/)
  })

  it('catches leaks via Scaffold body slot', () => {
    const leaky = defineWidget<{}>({
      id: 'sleaky',
      build: (scope) => [scaffold(scope.id('root'), { body: 'unscoped_body' })],
    })
    let err: Error | undefined
    try {
      leaky('a', {})
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'sleaky'")
    expect(err!.message).toContain("'unscoped_body'")
  })

  it('catches leaks via List.children.componentId (the easy-to-miss one)', () => {
    const leaky = defineWidget<{}>({
      id: 'lleaky',
      build: (scope) => [list(scope.id('lst'), '/items', 'unscoped_template')],
    })
    let err: Error | undefined
    try {
      leaky('a', {})
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'lleaky'")
    expect(err!.message).toContain("'unscoped_template'")
  })

  it('does NOT mistake pathRef strings for component refs', () => {
    // pathRef('/...') strings are NOT id refs; they should pass through
    // without tripping the leak guard.
    const w = defineWidget<{}>({
      id: 'pathy2',
      build: (scope) => [
        text(scope.id('t'), pathRef('/data/x')),
        list(scope.id('lst'), '/some/path', scope.id('tpl')),
        listItem(scope.id('tpl'), pathRef('$.name')),
      ],
    })
    expect(() => w('a', {})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Duplicate ids inside a widget
// ---------------------------------------------------------------------------

describe('defineWidget — duplicate ids in expansion', () => {
  it('throws when two components share the same scoped id', () => {
    const dup = defineWidget<{}>({
      id: 'dup',
      build: (scope) => [
        column(scope.id('root'), [scope.id('child')]),
        text(scope.id('child'), 'first'),
        text(scope.id('child'), 'second'), // duplicate scope.id('child')
      ],
    })
    let err: Error | undefined
    try {
      dup('a', {})
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("widget 'dup'")
    expect(err!.message).toContain("instance 'a'")
    expect(err!.message).toContain("'a__child'")
    expect(err!.message).toMatch(/duplicate/)
  })
})

// ---------------------------------------------------------------------------
// End-to-end with face-validation
// ---------------------------------------------------------------------------

describe('defineWidget — end-to-end with validateFaceComponents', () => {
  // Same shape as a real spend-tracker summary body, but fully scoped via
  // the widget API. Plugged into a face, it should produce zero issues.
  const summaryWidget = defineWidget<{}>({
    id: 'summaryBody',
    build: (scope) => [
      text(scope.id('total_label'), 'Total Spent', { typography: 'labelMedium' }),
      text(scope.id('total_value'), pathRef('/summary/total'), { typography: 'displayLarge' }),
      list(scope.id('recent_list'), '/recent_expenses', scope.id('expense_item')),
      listItem(scope.id('expense_item'), pathRef('$.description'), {
        supporting: pathRef('$.category'),
        trailing_content: scope.id('expense_amount'),
      }),
      text(scope.id('expense_amount'), pathRef('$.amount')),
    ],
  })

  it('a face containing a widget expansion validates with zero issues', () => {
    const expansion = summaryWidget('summary', {})
    const f = defineFace({
      id: 'summary',
      label: 'Summary',
      position: 0,
      viewToolDescription: 'Summary face',
      resolve: () => ({}),
      components: [
        scaffold('root', { body: 'content' }),
        column('content', ['summary__total_label', 'summary__total_value', 'summary__recent_list']),
        ...expansion,
      ],
    })
    expect(validateFaceComponents(f)).toEqual([])
  })

  it('two instances of the same widget in one face also validate cleanly', () => {
    const a = summaryWidget('top', {})
    const b = summaryWidget('btm', {})
    const f = defineFace({
      id: 'twin',
      label: 'Twin',
      position: 0,
      viewToolDescription: 'Twin face',
      resolve: () => ({}),
      components: [
        scaffold('root', { body: 'content' }),
        column('content', ['top__total_label', 'btm__total_label']),
        ...a,
        ...b,
      ],
    })
    expect(validateFaceComponents(f)).toEqual([])
  })
})
