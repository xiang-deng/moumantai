import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineFace } from '../../../src/server/agent/define-face.js'
import {
  scaffold,
  column,
  row,
  chip,
  text,
  progressRing,
  pathRef,
} from '../../../src/server/protocol/components/index.js'

const validSpec = {
  id: 'summary',
  label: 'Summary',
  position: 0,
  viewToolDescription: 'Show the summary face.',
  components: [
    { id: 'root', component: 'Scaffold', body: 'content' },
    { id: 'content', component: 'Column', children: ['total'] },
    { id: 'total', component: 'Text', text: { path: '/summary/total' } },
  ],
  resolve: () => ({
    summary: { total: 99.19 },
    recent_expenses: [],
  }),
}

describe('defineFace', () => {
  it('resolve is callable and returns nested data', () => {
    const face = defineFace(validSpec)
    const data = face.resolve({ db: {} as any, params: {} })
    expect(data).toEqual({ summary: { total: 99.19 }, recent_expenses: [] })
  })

  it('accepts params + viewToolDescription + paramsVersion', () => {
    const face = defineFace({
      ...validSpec,
      params: {
        month: { type: 'string', description: 'YYYY-MM' },
      },
      viewToolDescription: 'Show summary for a month.',
      paramsVersion: 2,
    })
    expect(face.params).toEqual({ month: { type: 'string', description: 'YYYY-MM' } })
    expect(face.viewToolDescription).toBe('Show summary for a month.')
    expect(face.paramsVersion).toBe(2)
  })

  it('throws if viewToolDescription is missing', () => {
    const { viewToolDescription: _, ...withoutDesc } = validSpec
    expect(() => defineFace(withoutDesc as never)).toThrow(/viewToolDescription/)
  })

  it.each([0, 1.5, -1])(
    'throws if paramsVersion is not a positive integer (%s)',
    (paramsVersion) => {
      expect(() =>
        defineFace({
          ...validSpec,
          params: { month: { type: 'string' } },
          paramsVersion,
        }),
      ).toThrow(/paramsVersion/)
    },
  )

  it('accepts paramsMerge: "merge" alongside params', () => {
    const face = defineFace({
      ...validSpec,
      params: { month: { type: 'string' } },
      paramsMerge: 'merge',
    })
    expect(face.paramsMerge).toBe('merge')
  })

  it('throws if paramsMerge is not "replace" or "merge"', () => {
    expect(() =>
      defineFace({
        ...validSpec,
        params: { month: { type: 'string' } },
        paramsMerge: 'partial' as never,
      }),
    ).toThrow(/paramsMerge/)
  })

  it('throws if paramsMerge: "merge" is set without `params` (incoherent)', () => {
    expect(() =>
      defineFace({
        ...validSpec,
        paramsMerge: 'merge',
      }),
    ).toThrow(/requires `params`/)
  })

  it.each([
    ['id', { id: '' }],
    ['label', { label: '' }],
    ['position', { position: 'first' as any }],
    ['components', { components: 'bad' as any }],
    ['resolve (null)', { resolve: null as any }],
    ['resolve (object)', { resolve: {} as any }],
  ])('throws if %s is invalid', (_, override) => {
    expect(() => defineFace({ ...validSpec, ...override })).toThrow()
  })

  it('supports position > 0 for non-primary faces', () => {
    const face = defineFace({ ...validSpec, id: 'chart', label: 'Chart', position: 1 })
    expect(face.position).toBe(1)
  })

  it('accepts and propagates a face-bound refresh', () => {
    const run = async () => ({ nextRun: '5s' })
    const face = defineFace({
      ...validSpec,
      refresh: { every: '30s', run },
    })
    expect(face.refresh).toBeDefined()
    expect(face.refresh!.every).toBe('30s')
    expect(face.refresh!.run).toBe(run)
  })

  it('throws when refresh.every is missing', () => {
    expect(() =>
      defineFace({
        ...validSpec,
        refresh: { every: '', run: async () => ({}) } as never,
      }),
    ).toThrow(/refresh\.every/)
  })

  it('throws when refresh.run is not a function', () => {
    expect(() =>
      defineFace({
        ...validSpec,
        refresh: { every: '5s', run: 'not a fn' as never },
      }),
    ).toThrow(/refresh\.run/)
  })

  // ---------------------------------------------------------------------------
  // Compact-discipline guards — warn-mode
  // ---------------------------------------------------------------------------
  describe('compact-discipline guards', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warnSpy.mockRestore()
    })

    const compactBase = {
      id: 'glance',
      label: 'Glance',
      position: 0,
      kind: 'compact' as const,
      viewToolDescription: 'A glance-first face.',
      resolve: () => ({}),
    }

    it('does not warn when kind is not compact, even on rule-breakers', () => {
      defineFace({
        ...compactBase,
        kind: 'expanded',
        components: [
          scaffold('root', { body: 'content' }),
          column('content', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
          ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => text(id, id)),
        ],
      })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('warns on >6 body children', () => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
      defineFace({
        ...compactBase,
        components: [
          scaffold('root', { body: 'content' }),
          column('content', ids),
          ...ids.map((id) => text(id, id)),
        ],
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/children \(>6\)/))
    })

    it('warns on Row with >2 selected-chip children', () => {
      defineFace({
        ...compactBase,
        components: [
          scaffold('root', { body: 'content' }),
          column('content', ['chips']),
          row('chips', ['c1', 'c2', 'c3']),
          chip('c1', 'A', { selected: pathRef('/a') }),
          chip('c2', 'B', { selected: pathRef('/b') }),
          chip('c3', 'C', { selected: pathRef('/c') }),
        ],
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/chips with selected bindings/))
    })

    it('warns on ProgressRing size > 100 on compact', () => {
      defineFace({
        ...compactBase,
        components: [
          scaffold('root', { body: 'content' }),
          column('content', ['ring']),
          progressRing('ring', 50, 100, { size: 180 }),
        ],
      })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/ProgressRing.*size=180dp \(>100dp\)/),
      )
    })

    it('does not warn on a well-formed compact face', () => {
      defineFace({
        ...compactBase,
        components: [
          scaffold('root', { body: 'content' }),
          column('content', ['ring']),
          progressRing('ring', 50, 100, { size: 100 }),
        ],
      })
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
