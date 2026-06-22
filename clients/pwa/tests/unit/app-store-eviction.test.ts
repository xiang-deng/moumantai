import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore, NEIGHBOR_WINDOW } from '../../src/renderer/stores/app-store'
import type { ComponentDef, AppInfo, FaceInfo } from '@moumantai/protocol/generated/moumantai/v1'

/**
 * Coverage for the proximity-cache `evictInactiveApps` action. The store is
 * the single source of cache truth; eviction is invoked on every swipe so
 * memory stays bounded to `NEIGHBOR_WINDOW * 2 + 1` apps with face content.
 */

function appInfo(id: string, position: number): AppInfo {
  return {
    $typeName: 'moumantai.v1.AppInfo' as const,
    appId: id,
    label: id,
    icon: 'app',
    position,
    themeSeed: '',
  } as AppInfo
}

function faceInfo(id: string, position: number): FaceInfo {
  return {
    $typeName: 'moumantai.v1.FaceInfo' as const,
    faceId: id,
    label: id,
    position,
  } as FaceInfo
}

function comp(id: string): ComponentDef {
  return {
    $typeName: 'moumantai.v1.ComponentDef' as const,
    id,
  } as unknown as ComponentDef
}

/** Seed N apps in order with one face each + populated components/data. */
function seed(n: number) {
  const store = useAppStore.getState()
  store.reset()
  const apps: AppInfo[] = []
  for (let i = 0; i < n; i++) apps.push(appInfo(`app${i}`, i))
  useAppStore.getState().setAppList(apps)
  for (let i = 0; i < n; i++) {
    useAppStore.getState().setFaceList(`app${i}`, [faceInfo('main', 0)])
    useAppStore.getState().updateFace(`app${i}`, 'main', [comp('c1')], { hello: i })
  }
}

function faceOf(appId: string) {
  return useAppStore.getState().apps.get(appId)?.faces.get('main')
}

describe('evictInactiveApps — proximity cache', () => {
  beforeEach(() => useAppStore.getState().reset())

  it('NEIGHBOR_WINDOW is 1', () => {
    expect(NEIGHBOR_WINDOW).toBe(1)
  })

  it('keeps active + one each side, evicts the rest (radius 1)', () => {
    seed(5)
    useAppStore.getState().evictInactiveApps(2, 1)

    // Within window: components + data preserved
    for (const i of [1, 2, 3]) {
      const face = faceOf(`app${i}`)!
      expect(face.components.size, `app${i} keeps components`).toBe(1)
      expect(face.data, `app${i} keeps data`).toEqual({ hello: i })
    }
    // Outside window: emptied
    for (const i of [0, 4]) {
      const face = faceOf(`app${i}`)!
      expect(face.components.size, `app${i} evicted`).toBe(0)
      expect(face.data, `app${i} data cleared`).toEqual({})
    }
  })

  it('preserves $form across eviction', () => {
    seed(3)
    useAppStore.getState().setFormValue('app0', 'main', 'draft', 'hello')
    useAppStore.getState().evictInactiveApps(2, 1)

    const face = faceOf('app0')!
    expect(face.components.size, 'components dropped').toBe(0)
    expect(face.data, 'data dropped').toEqual({})
    expect(face.form, 'form survived').toEqual({ draft: 'hello' })
  })

  it('is a referential no-op when all targeted apps are already empty', () => {
    seed(5)
    // First eviction populates the "outside-window" empties.
    useAppStore.getState().evictInactiveApps(2, 1)
    const before = useAppStore.getState().apps
    // Second eviction with same args: nothing actually changes.
    useAppStore.getState().evictInactiveApps(2, 1)
    expect(useAppStore.getState().apps, 'reference equality').toBe(before)
  })

  it('handles first app — no negative index leak (activeIndex=0)', () => {
    seed(4)
    useAppStore.getState().evictInactiveApps(0, 1)

    expect(faceOf('app0')!.components.size).toBe(1)
    expect(faceOf('app1')!.components.size).toBe(1)
    expect(faceOf('app2')!.components.size).toBe(0)
    expect(faceOf('app3')!.components.size).toBe(0)
  })

  it('handles last app — no out-of-bounds (activeIndex=N-1)', () => {
    seed(4)
    useAppStore.getState().evictInactiveApps(3, 1)

    expect(faceOf('app0')!.components.size).toBe(0)
    expect(faceOf('app1')!.components.size).toBe(0)
    expect(faceOf('app2')!.components.size).toBe(1)
    expect(faceOf('app3')!.components.size).toBe(1)
  })

  it('is parameterized — window=3 retains more apps than window=1', () => {
    seed(8)
    useAppStore.getState().evictInactiveApps(3, 3)
    // Distance 0..3 from active(3): apps 0..6 kept; app7 evicted.
    for (let i = 0; i <= 6; i++) {
      expect(faceOf(`app${i}`)!.components.size, `app${i} kept`).toBe(1)
    }
    expect(faceOf('app7')!.components.size).toBe(0)
  })

  it('no-op when no apps are loaded', () => {
    const before = useAppStore.getState().apps
    useAppStore.getState().evictInactiveApps(0, 1)
    expect(useAppStore.getState().apps).toBe(before)
  })
})
