import { describe, it, expect, vi } from 'vitest'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import { refreshFace, refreshAllFaces } from '../../../src/server/agent/face-refresh.js'
import type { FaceDefinition } from '../../../src/server/agent/types.js'

const mockDeps = { db: {} as any, paramsByFaceId: {} }

function makeFace(
  id: string,
  position: number,
  data: Record<string, unknown> = {},
): FaceDefinition {
  return {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    position,
    components: [
      { id: 'root', component: 'Scaffold', body: 'content' },
      { id: 'content', component: 'Text', text: `Face: ${id}` },
    ],
    resolve: () => data,
  }
}

describe('refreshFace', () => {
  it('sends faceUpdate with components and resolved data', () => {
    const registry = new FaceRegistry()
    registry.register(makeFace('summary', 0, { total: 99.19 }), { skipValidation: true })

    const sendFaceUpdate = vi.fn()
    refreshFace('spend-tracker', 'summary', registry, mockDeps, sendFaceUpdate)

    expect(sendFaceUpdate).toHaveBeenCalledOnce()
    const [appId, faceId, reg, data] = sendFaceUpdate.mock.calls[0]
    expect(appId).toBe('spend-tracker')
    expect(faceId).toBe('summary')
    expect(reg).toBe(registry)
    expect(data).toEqual({ total: 99.19, $params: {} })
  })

  it('does nothing for unknown face', () => {
    const registry = new FaceRegistry()
    const sendFaceUpdate = vi.fn()
    refreshFace('app', 'unknown', registry, mockDeps, sendFaceUpdate)
    expect(sendFaceUpdate).not.toHaveBeenCalled()
  })
})

describe('refreshAllFaces', () => {
  it('sends faceUpdate for every registered face', () => {
    const registry = new FaceRegistry()
    registry.register(makeFace('summary', 0, { total: 100 }), { skipValidation: true })
    registry.register(makeFace('chart', 1, { data: [1, 2, 3] }), { skipValidation: true })

    const sendFaceUpdate = vi.fn()
    refreshAllFaces('spend-tracker', registry, mockDeps, sendFaceUpdate)

    expect(sendFaceUpdate).toHaveBeenCalledTimes(2)

    // Sorted by position: summary (0) first, chart (1) second
    const [call1, call2] = sendFaceUpdate.mock.calls
    expect(call1[0]).toBe('spend-tracker')
    expect(call1[1]).toBe('summary')
    expect(call1[3]).toEqual({ total: 100, $params: {} })

    expect(call2[0]).toBe('spend-tracker')
    expect(call2[1]).toBe('chart')
    expect(call2[3]).toEqual({ data: [1, 2, 3], $params: {} })
  })

  it('does nothing when registry is empty', () => {
    const registry = new FaceRegistry()
    const sendFaceUpdate = vi.fn()
    refreshAllFaces('app', registry, mockDeps, sendFaceUpdate)
    expect(sendFaceUpdate).not.toHaveBeenCalled()
  })

  it('skips faces not in mountedFaceIds', () => {
    const summaryResolve = vi.fn(() => ({ total: 100 }))
    const chartResolve = vi.fn(() => ({ data: [1, 2, 3] }))
    const registry = new FaceRegistry()
    registry.register({
      id: 'summary',
      label: 'S',
      position: 0,
      components: [],
      resolve: summaryResolve,
    })
    registry.register({
      id: 'chart',
      label: 'C',
      position: 1,
      components: [],
      resolve: chartResolve,
    })

    const sendFaceUpdate = vi.fn()
    refreshAllFaces(
      'spend-tracker',
      registry,
      mockDeps,
      sendFaceUpdate,
      new Set(['summary']), // only summary mounted
    )

    expect(summaryResolve).toHaveBeenCalledOnce()
    expect(chartResolve).not.toHaveBeenCalled()
    expect(sendFaceUpdate).toHaveBeenCalledOnce()
    expect(sendFaceUpdate.mock.calls[0][1]).toBe('summary')
  })

  it('treats empty mountedFaceIds as "no clients viewing" — no resolves, no broadcasts', () => {
    const resolveFn = vi.fn(() => ({}))
    const registry = new FaceRegistry()
    registry.register({
      id: 'summary',
      label: 'S',
      position: 0,
      components: [],
      resolve: resolveFn,
    })

    const sendFaceUpdate = vi.fn()
    refreshAllFaces('app', registry, mockDeps, sendFaceUpdate, new Set())

    expect(resolveFn).not.toHaveBeenCalled()
    expect(sendFaceUpdate).not.toHaveBeenCalled()
  })

  it('resolves fresh data each time (not cached)', () => {
    let counter = 0
    const registry = new FaceRegistry()
    registry.register({
      id: 'live',
      label: 'Live',
      position: 0,
      components: [],
      resolve: () => ({ count: ++counter }),
    })

    const sendFaceUpdate = vi.fn()
    refreshAllFaces('app', registry, mockDeps, sendFaceUpdate)
    refreshAllFaces('app', registry, mockDeps, sendFaceUpdate)

    expect(sendFaceUpdate.mock.calls[0][3]).toEqual({ count: 1, $params: {} })
    expect(sendFaceUpdate.mock.calls[1][3]).toEqual({ count: 2, $params: {} })
  })
})
