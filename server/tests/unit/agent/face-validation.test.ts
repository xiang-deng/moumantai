/**
 * Unit tests for face-validation.
 *
 * Strategy: build fixtures with the real component builders (moumantai/ui) so
 * the assertions exercise the actual ComponentDef shape — same wire form the
 * validator sees in production. Each error code gets a failing fixture AND a
 * passing fixture so we know each rule is independently enforced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  scaffold,
  topBar,
  column,
  row,
  card,
  box,
  text,
  image,
  button,
  list,
  listItem,
  tabs,
  modal,
  switchToggle,
  pathRef,
  invokeTool,
} from '../../../src/server/protocol/components/index.js'
import { defineFace } from '../../../src/server/agent/define-face.js'
import {
  validateFaceComponents,
  enforceFaceValidation,
} from '../../../src/server/agent/face-validation.js'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import { SizeClass } from '@moumantai/protocol/generated/moumantai/v1'
import type { FaceDefinition } from '../../../src/server/agent/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function face(components: ReturnType<typeof scaffold>[], id = 'f1'): FaceDefinition {
  return defineFace({
    id,
    label: 'F',
    position: 0,
    viewToolDescription: `Test face ${id}.`,
    components,
    resolve: () => ({}),
  })
}

// A minimal valid face — used as a baseline for "negative" fixtures so we
// know the only thing tripping a rule is what we changed.
function validFixture(): FaceDefinition {
  return face([scaffold('root', { body: 'content' }), column('content', ['t']), text('t', 'hello')])
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateFaceComponents — happy path', () => {
  it('produces zero issues for a valid face', () => {
    expect(validateFaceComponents(validFixture())).toEqual([])
  })

  it('accepts a Column-rooted face (Column also valid as root)', () => {
    const f = face([column('root', ['t']), text('t', 'hello')])
    expect(validateFaceComponents(f)).toEqual([])
  })

  it('accepts a Scaffold with empty/unset slots', () => {
    // Only `body` is set; topBar / fab unset is OK.
    const f = face([scaffold('root', { body: 'content' }), column('content', [])])
    expect(validateFaceComponents(f)).toEqual([])
  })

  it('accepts a complex face with TopBar actions, Tabs, and a List', () => {
    const f = face([
      scaffold('root', { top_bar: 'top', body: 'tabs1' }),
      topBar('top', 'Title', { actions: ['act1'] }),
      button('act1', 'Add'),
      tabs('tabs1', ['A', 'B'], ['paneA', 'paneB']),
      column('paneA', ['list1']),
      list('list1', '/items', 'tpl'),
      listItem('tpl', pathRef('$.name'), { trailing_content: 'sw' }),
      // Switch inside a list template requires `action` (fires on change with
      // row's itemScope) — without it, the validator rejects: $form/<id>
      // would collide across rows.
      switchToggle('sw', pathRef('$.on'), {
        action: invokeTool('toggle_item', { id: pathRef('$.id') }),
      }),
      column('paneB', []),
    ])
    expect(validateFaceComponents(f)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Root checks
// ---------------------------------------------------------------------------

describe('validateFaceComponents — root', () => {
  it('errors if no component has id="root"', () => {
    const f = face([scaffold('main', { body: 'content' }), column('content', [])])
    const issues = validateFaceComponents(f)
    expect(issues).toContainEqual(
      expect.objectContaining({
        level: 'error',
        code: 'missing-root',
        message: expect.stringContaining('no component with id="root"'),
      }),
    )
  })

  it('errors if root is not Scaffold or Column', () => {
    const f = face([text('root', 'oops')])
    const issues = validateFaceComponents(f)
    const rootIssue = issues.find((i) => i.code === 'missing-root')
    expect(rootIssue).toMatchObject({
      level: 'error',
      componentId: 'root',
    })
    expect(rootIssue?.message).toMatch(/Scaffold or Column/)
    expect(rootIssue?.message).toMatch(/got text/)
  })
})

// ---------------------------------------------------------------------------
// Duplicate id
// ---------------------------------------------------------------------------

describe('validateFaceComponents — duplicate id', () => {
  it('flags every duplicate after the first occurrence', () => {
    const f = face([
      scaffold('root', { body: 'a' }),
      column('a', ['x']),
      text('x', 'first'),
      text('x', 'second'), // duplicate
      text('x', 'third'), // duplicate
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'duplicate-id')
    expect(issues).toHaveLength(2)
    for (const i of issues) {
      expect(i.level).toBe('error')
      expect(i.componentId).toBe('x')
      expect(i.message).toMatch(/duplicate component id "x"/)
    }
  })
})

// ---------------------------------------------------------------------------
// Unknown ref — exhaustive per ID-bearing field
// ---------------------------------------------------------------------------

describe('validateFaceComponents — unknown-ref (Column.children)', () => {
  it('errors when Column.children references an undefined id', () => {
    const f = face([
      scaffold('root', { body: 'content' }),
      column('content', ['heading']), // typo — should be 'header'
      text('header', 'hi'),
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      level: 'error',
      code: 'unknown-ref',
      componentId: 'content',
    })
    expect(issues[0].message).toMatch(/references unknown id "heading"/)
  })

  it('errors when Row.children references an undefined id', () => {
    const f = face([scaffold('root', { body: 'r' }), row('r', ['ghost'])])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/"ghost"/)
  })

  it('errors when Card.children references an undefined id', () => {
    const f = face([scaffold('root', { body: 'c' }), card('c', ['ghost'])])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')).toHaveLength(1)
  })

  it('errors when Modal.children references an undefined id', () => {
    const f = face([scaffold('root', { body: 'col' }), column('col', []), modal('m', ['ghost'])])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')).toHaveLength(1)
  })

  it('errors when Box.children references an undefined id', () => {
    const f = face([scaffold('root', { body: 'b' }), box('b', ['ghost'])])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ componentId: 'b' })
    expect(issues[0].message).toMatch(/"ghost"/)
  })
})

describe('validateFaceComponents — unknown-ref (Scaffold slots)', () => {
  it('errors when Scaffold.body references an undefined id', () => {
    const f = face([scaffold('root', { body: 'phantom' })])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ componentId: 'root' })
    expect(issues[0].message).toMatch(/"phantom"/)
  })

  it('errors on dangling Scaffold.topBar and Scaffold.fab', () => {
    const f = face([
      scaffold('root', { top_bar: 'ghostTop', body: 'b', fab: 'ghostFab' }),
      column('b', []),
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/ghostTop/)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/ghostFab/)
  })
})

describe('validateFaceComponents — unknown-ref (TopBar.actions)', () => {
  it('errors when TopBar.actions has a dangling id', () => {
    const f = face([
      scaffold('root', { top_bar: 'top', body: 'col' }),
      topBar('top', 'T', { actions: ['ghost'] }),
      column('col', []),
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ componentId: 'top' })
  })
})

describe('validateFaceComponents — unknown-ref (Tabs.tabContent)', () => {
  it('errors when Tabs.tabContent references an undefined id', () => {
    const f = face([
      scaffold('root', { body: 't' }),
      tabs('t', ['A', 'B'], ['paneA', 'ghost']),
      column('paneA', []),
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/"ghost"/)
    expect(issues[0]).toMatchObject({ componentId: 't' })
  })
})

describe('validateFaceComponents — unknown-ref (ListItem.trailingContent)', () => {
  it('errors when ListItem.trailing_content is dangling', () => {
    const f = face([
      scaffold('root', { body: 'l' }),
      list('l', '/items', 'tpl'),
      listItem('tpl', pathRef('$.name'), { trailing_content: 'ghost' }),
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ componentId: 'tpl' })
    expect(issues[0].message).toMatch(/"ghost"/)
  })
})

describe('validateFaceComponents — unknown-ref (ListChildren.componentId)', () => {
  // The easy-to-miss one: List wraps its templateId inside a ListChildren message.
  it('errors when List references an undefined templateId', () => {
    const f = face([
      scaffold('root', { body: 'l' }),
      list('l', '/items', 'ghost-template'), // template id never defined
    ])
    const issues = validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ componentId: 'l' })
    expect(issues[0].message).toMatch(/"ghost-template"/)
  })
})

// ---------------------------------------------------------------------------
// pathRef false-positive guard
// ---------------------------------------------------------------------------

describe('validateFaceComponents — pathRef strings are NOT mistaken for component refs', () => {
  it('text bound via pathRef does not produce unknown-ref', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['greeting']),
      text('greeting', pathRef('/some/data/path')),
    ])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')).toEqual([])
  })

  it('list itemsPath (a JSON pointer) is not validated as an id', () => {
    // '/items' looks like an id but is a JSON pointer; only componentId is an id.
    const f = face([
      scaffold('root', { body: 'l' }),
      list('l', '/some/long/path/that/is/not/an/id', 'tpl'),
      listItem('tpl', pathRef('$.name')),
    ])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-ref')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Stylistic-string warnings (Image fit only)
//
// Intent fields (emphasis/tone) on Button/Card/Chip are compile-time typed;
// typos are caught by `apps:typecheck` and silently fall back at runtime.
// Image `fit` retains runtime validation because its catalog is closed.
// ---------------------------------------------------------------------------

describe('validateFaceComponents — Image fit (warnings, not errors)', () => {
  it('known intent values produce no warning (compile-time typed; runtime lenient)', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['btn', 'crd']),
      button('btn', 'OK', { emphasis: 'primary' }),
      card('crd', [], { emphasis: 'elevated' }),
    ])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-variant')).toEqual([])
  })

  it('Image fit alias "cover" resolves and produces no warning', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['img']),
      image('img', 'https://example.com/x.png', { fit: 'cover' }),
    ])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-variant')).toEqual([])
  })

  it('canonical Image fit "contain" produces no warning', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['img']),
      image('img', 'x.png', { fit: 'contain' }),
    ])
    expect(validateFaceComponents(f).filter((i) => i.code === 'unknown-variant')).toEqual([])
  })

  it('warns on unknown Image fit', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['img']),
      image('img', 'x.png', { fit: 'made-up-fit' }),
    ])
    const warns = validateFaceComponents(f).filter((i) => i.code === 'unknown-variant')
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toMatch(/fit "made-up-fit"/)
  })
})

// ---------------------------------------------------------------------------
// FaceRegistry boundary — every face entering the runtime is validated
// regardless of source (static load, LLM addFace, hot-reload).
// ---------------------------------------------------------------------------

describe('enforceFaceValidation — policy', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('throws with the offending face id and each error code aggregated', () => {
    const broken = face(
      [
        scaffold('root', { body: 'phantom' }),
        column('content', ['heading']), // dangling
      ],
      'broken-summary',
    )

    let caught: Error | undefined
    try {
      enforceFaceValidation(broken, '/test/index.ts')
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught!.message).toContain('broken-summary')
    expect(caught!.message).toContain('unknown-ref')
    // Both errors aggregated into one throw, not just the first.
    expect(caught!.message).toContain('phantom')
    expect(caught!.message).toContain('heading')
    // Source label is in the first line.
    expect(caught!.message.split('\n')[0]).toContain('/test/index.ts')
  })

  it('logs warnings (not throws) for unknown Image fit', () => {
    const f = face([
      scaffold('root', { body: 'col' }),
      column('col', ['img']),
      image('img', 'x.png', { fit: 'made-up-fit' }),
    ])
    expect(() => enforceFaceValidation(f, '/test/index.ts')).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/unknown-variant/)
    expect(warnSpy.mock.calls[0][0]).toMatch(/made-up-fit/)
  })

  it('does not throw or warn for a clean face', () => {
    expect(() => enforceFaceValidation(validFixture(), '/test/index.ts')).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // Regression: NaN enum values pass graph validation but fail at wire serialization
  // ("invalid int32: NaN"), crashing the server at preview time. Validation must catch
  // them first — drafts skip tsc so the type error slips by.
  it('throws for a component that will not serialize (NaN enum)', () => {
    const f = face([
      // `as never` bypasses the compile-time guard the way an un-typechecked
      // draft would; NaN survives create() but fails toBinary.
      scaffold('root', { body: 'content', body_kind: NaN as never }),
      column('content', ['t']),
      text('t', 'hello'),
    ])
    expect(() => enforceFaceValidation(f, '/test/index.ts')).toThrow(/will not serialize/)
  })
})

describe('FaceRegistry — validates on register (catches LLM addFace + hot-reload paths)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('register() throws on a face with a dangling ref', () => {
    const reg = new FaceRegistry()
    const broken = face([scaffold('root', { body: 'phantom' })], 'broken')
    expect(() => reg.register(broken, { source: 'addFace:test' })).toThrow(/unknown-ref.*phantom/)
    // Source label in error message
    try {
      reg.register(broken, { source: 'addFace:test' })
    } catch (err) {
      expect((err as Error).message).toContain('addFace:test')
    }
  })

  it('register() succeeds and warns on unknown Image fit', () => {
    const reg = new FaceRegistry()
    const f = face(
      [
        scaffold('root', { body: 'col' }),
        column('col', ['img']),
        image('img', 'x.png', { fit: 'made-up-fit' }),
      ],
      'with-warn',
    )
    expect(() => reg.register(f, { source: 'hot-reload:test' })).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/unknown-variant/)
  })

  it('registerVariant() also validates', () => {
    const reg = new FaceRegistry()
    reg.register(validFixture()) // base face
    const broken = face([scaffold('root', { body: 'nope' })], 'f1')
    expect(() => reg.registerVariant('f1', SizeClass.COMPACT, broken)).toThrow(/unknown-ref/)
  })

  it('skipValidation: true bypasses validation (test-only escape hatch)', () => {
    const reg = new FaceRegistry()
    const broken = face([scaffold('root', { body: 'phantom' })], 'broken')
    expect(() => reg.register(broken, { skipValidation: true })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Parameterized faces (rules introduced for view_<faceId> synth tools)
// ---------------------------------------------------------------------------

describe('validateFaceComponents — params rules', () => {
  // We bypass defineFace's own checks by constructing the FaceDefinition
  // directly so we can probe each face-validation rule in isolation.
  function rawFace(overrides: Partial<FaceDefinition>): FaceDefinition {
    return {
      id: 'summary',
      label: 'Summary',
      position: 0,
      components: [
        scaffold('root', { body: 'content' }),
        column('content', ['t']),
        text('t', 'hi'),
      ],
      resolve: () => ({}),
      ...overrides,
    }
  }

  it.each<[string, Partial<FaceDefinition>, string]>([
    [
      'required: true on a param',
      { params: { month: { type: 'string', required: true } }, viewToolDescription: 'x' },
      'required-face-param',
    ],
    [
      'params without viewToolDescription',
      { params: { month: { type: 'string' } } },
      'missing-view-tool-description',
    ],
    [
      'face id starting with view_',
      { id: 'view_xyz', params: { x: { type: 'string' } }, viewToolDescription: 'x' },
      'reserved-face-id-prefix',
    ],
  ])('rejects %s (code: %s)', (_, override, code) => {
    expect(validateFaceComponents(rawFace(override)).some((i) => i.code === code)).toBe(true)
  })

  it('accepts a valid parameterized face', () => {
    const f = rawFace({
      params: {
        month: { type: 'string', description: 'YYYY-MM' },
        category: { type: 'string', description: 'category id' },
      },
      viewToolDescription: 'Show monthly spend; pass month + optional category.',
    })
    expect(validateFaceComponents(f).filter((i) => i.level === 'error')).toEqual([])
  })

  it('does not enforce params rules for faces without params (params are optional)', () => {
    const codes = validateFaceComponents(rawFace({})).map((i) => i.code)
    expect(codes).not.toContain('required-face-param')
    expect(codes).not.toContain('missing-view-tool-description')
    expect(codes).not.toContain('reserved-face-id-prefix')
  })
})
