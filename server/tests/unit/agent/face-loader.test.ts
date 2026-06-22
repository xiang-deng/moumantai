import { describe, it, expect, vi } from 'vitest'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import type { FaceDefinition } from '../../../src/server/agent/types.js'

function makeFace(overrides: Partial<FaceDefinition> = {}): FaceDefinition {
  return {
    id: 'summary',
    label: 'Summary',
    position: 0,
    components: [{ id: 'root', component: 'Scaffold', body: 'content' }],
    resolve: () => ({
      total: 42,
      items: [{ name: 'a' }, { name: 'b' }],
    }),
    ...overrides,
  }
}

const mockDeps = { db: {} as any, paramsByFaceId: {} }

describe('FaceRegistry', () => {
  describe('register + get', () => {
    it('registers and retrieves a face', () => {
      const registry = new FaceRegistry()
      const face = makeFace()
      registry.register(face, { skipValidation: true })
      expect(registry.get('summary')).toBe(face)
    })

    it('returns undefined for unregistered face', () => {
      const registry = new FaceRegistry()
      expect(registry.get('nonexistent')).toBeUndefined()
    })

    it('replaces existing face with same id', () => {
      const registry = new FaceRegistry()
      const face1 = makeFace({ label: 'v1' })
      const face2 = makeFace({ label: 'v2' })
      registry.register(face1, { skipValidation: true })
      registry.register(face2, { skipValidation: true })
      expect(registry.get('summary')!.label).toBe('v2')
      expect(registry.size).toBe(1)
    })
  })

  describe('list', () => {
    it('returns faces sorted by position', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'chart', label: 'Chart', position: 2 }), {
        skipValidation: true,
      })
      registry.register(makeFace({ id: 'summary', label: 'Summary', position: 0 }), {
        skipValidation: true,
      })
      registry.register(makeFace({ id: 'detail', label: 'Detail', position: 1 }), {
        skipValidation: true,
      })

      const list = registry.list()
      expect(list.map((f) => f.id)).toEqual(['summary', 'detail', 'chart'])
    })

    it('returns empty array when no faces registered', () => {
      const registry = new FaceRegistry()
      expect(registry.list()).toEqual([])
    })
  })

  describe('remove', () => {
    it('removes an existing face and returns true', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'a', position: 0 }), { skipValidation: true })
      expect(registry.remove('a')).toBe(true)
      expect(registry.size).toBe(0)
      expect(registry.get('a')).toBeUndefined()
    })

    it('returns false for non-existent face', () => {
      const registry = new FaceRegistry()
      expect(registry.remove('nope')).toBe(false)
    })
  })

  describe('resolveOne', () => {
    it('runs resolve for a face and returns nested data with $params merged', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace(), { skipValidation: true })
      const data = registry.resolveOne('summary', mockDeps)
      expect(data).toEqual({
        total: 42,
        items: [{ name: 'a' }, { name: 'b' }],
        $params: {},
      })
    })

    it('returns empty object for unknown face', () => {
      const registry = new FaceRegistry()
      expect(registry.resolveOne('unknown', mockDeps)).toEqual({})
    })

    it('passes deps (db + params) to resolve', () => {
      let receivedDeps: any = null
      const registry = new FaceRegistry()
      registry.register(
        makeFace({
          resolve: (deps) => {
            receivedDeps = deps
            return { ok: true }
          },
        }),
        { skipValidation: true },
      )
      const db = { custom: true } as any
      const params = { month: '2026-04' }
      registry.resolveOne('summary', { db, paramsByFaceId: { summary: params } })
      expect(receivedDeps.db).toBe(db)
      expect(receivedDeps.params).toEqual(params)
    })

    it('merges $params into resolved data tree', () => {
      const registry = new FaceRegistry()
      registry.register(
        makeFace({
          resolve: ({ params }) => ({ month: (params as { month?: string }).month }),
        }),
        { skipValidation: true },
      )
      const data = registry.resolveOne('summary', {
        db: {} as any,
        paramsByFaceId: { summary: { month: '2026-02' } },
      })
      expect(data).toEqual({
        month: '2026-02',
        $params: { month: '2026-02' },
      })
    })

    it('handles resolve errors gracefully (returns $params-only object)', () => {
      const registry = new FaceRegistry()
      registry.register(
        makeFace({
          resolve: () => {
            throw new Error('resolve crashed')
          },
        }),
        { skipValidation: true },
      )
      const data = registry.resolveOne('summary', mockDeps)
      expect(data).toEqual({ $params: {} })
    })
  })

  describe('resolveAll', () => {
    it('resolves all faces and returns Map (with $params merged)', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'a', position: 0, resolve: () => ({ x: 1 }) }), {
        skipValidation: true,
      })
      registry.register(makeFace({ id: 'b', position: 1, resolve: () => ({ y: 2 }) }), {
        skipValidation: true,
      })

      const all = registry.resolveAll(mockDeps)
      expect(all.size).toBe(2)
      expect(all.get('a')).toEqual({ x: 1, $params: {} })
      expect(all.get('b')).toEqual({ y: 2, $params: {} })
    })
  })

  describe('registerVariant + selectForSize', () => {
    it('returns default face when no variant matches', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'summary' }), { skipValidation: true })
      const selected = registry.selectForSize('summary', 'expanded')
      expect(selected.id).toBe('summary')
      expect(selected.components[0].id).toBe('root')
    })

    it('returns variant face when sizeClass matches', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'summary' }), { skipValidation: true })
      const expandedFace = makeFace({
        id: 'summary',
        components: [{ id: 'root', component: 'Scaffold', body: 'content', topBar: 'top' }],
      })
      registry.registerVariant('summary', 'expanded', expandedFace, { skipValidation: true })

      const compact = registry.selectForSize('summary', 'compact')
      expect(compact.components[0].id).toBe('root')
      expect((compact.components[0] as any).topBar).toBeUndefined()

      const expanded = registry.selectForSize('summary', 'expanded')
      expect((expanded.components[0] as any).topBar).toBe('top')
    })

    it('warns and returns stub for unknown face', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const registry = new FaceRegistry()
      const result = registry.selectForSize('nonexistent', 'compact')
      expect(result.id).toBe('nonexistent')
      expect(result.components).toEqual([])
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
      spy.mockRestore()
    })

    it('list() returns only default faces', () => {
      const registry = new FaceRegistry()
      registry.register(makeFace({ id: 'a', position: 0 }), { skipValidation: true })
      registry.registerVariant('a', 'expanded', makeFace({ id: 'a', position: 0 }), {
        skipValidation: true,
      })
      expect(registry.list()).toHaveLength(1)
    })
  })
})
