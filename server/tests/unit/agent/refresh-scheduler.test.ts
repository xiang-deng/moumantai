import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineRefreshTask } from '../../../src/server/agent/define-refresh-task.js'
import {
  RefreshScheduler,
  type MountedFaceEntry,
} from '../../../src/server/agent/refresh-scheduler.js'
import type { RefreshContext, FaceBoundRefresh } from '../../../src/server/agent/types.js'

function fakeCtx(): Omit<RefreshContext, 'params'> {
  return {
    db: null as never,
    http: { fetch: async () => new Response('') },
    cacheAsset: async (url) => url,
    config: {},
    context: {},
    setContext: async () => undefined,
  }
}

/** Build a mounted-set entry. `scope` defaults to `app:<appId>`. */
function mount(
  appId: string,
  faceId = 'home',
  params: Record<string, unknown> = {},
  deviceId = 'test-dev',
): MountedFaceEntry {
  return { deviceId, scope: `app:${appId}`, faceId, params }
}

let mounted: MountedFaceEntry[]

beforeEach(() => {
  mounted = []
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('warmup', () => {
  it('runs warmup-flagged tasks once at boot', async () => {
    const calls: string[] = []
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })

    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: true,
          run: async () => {
            calls.push('refresh_today')
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })

    await scheduler.warmup('sports')
    expect(calls).toEqual(['refresh_today'])
  })

  it('skips tasks with warmup:false at boot', async () => {
    const calls: string[] = []
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls.push('refresh_today')
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    await scheduler.warmup('sports')
    expect(calls).toEqual([])
  })

  it('runs warmup regardless of mounted state', async () => {
    const calls: number[] = []
    mounted = [] // empty — no client mounted
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          run: async () => {
            calls.push(Date.now())
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    await scheduler.warmup('sports')
    expect(calls).toHaveLength(1)
  })
})

describe('mountedOnly gating', () => {
  it('skips ticks when scope is not mounted; runs when mounted', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '1s',
          mountedOnly: true,
          warmup: false,
          run: async () => {
            calls.push(Date.now())
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })

    scheduler.start()

    // First tick at +1s, no mount → skip
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toHaveLength(0)

    // Mount scope, next tick should run
    mounted.push(mount('sports'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toHaveLength(1)

    scheduler.stop()
  })

  it('mountedOnly:false runs regardless of mount state', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '1s',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls.push(Date.now())
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toHaveLength(1)
    scheduler.stop()
  })
})

describe('adaptive cadence (nextRun)', () => {
  it('uses nextRun for the following tick instead of every', async () => {
    vi.useFakeTimers()
    mounted.push(mount('sports'))
    const ticks: number[] = []
    let nextRun = '5s'
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '1m', // default would be 60s
          warmup: false,
          run: async () => {
            ticks.push(Date.now())
            return { nextRun }
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    scheduler.start()

    // First tick at 60s (every='1m')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ticks).toHaveLength(1)
    // Next tick should be at +5s (nextRun='5s' returned from tick 1), not +60s
    await vi.advanceTimersByTimeAsync(4_000)
    expect(ticks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ticks).toHaveLength(2)

    // Change the nextRun the body returns. Takes effect AFTER the next run
    // reads the new value — i.e., tick 3 fires at +5s (still using prior
    // nextRun), then tick 4 fires at +1s using the new value.
    nextRun = '1s'
    await vi.advanceTimersByTimeAsync(4_500) // tick 3 fires at +5s; tick 4 not yet (+1s after that)
    expect(ticks).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000) // tick 4 fires (+1s, faster cadence)
    expect(ticks).toHaveLength(4)

    scheduler.stop()
  })
})

describe('in-flight dedup', () => {
  it('two concurrent invokes return the same promise (one body run)', async () => {
    let calls = 0
    let resolveBody: () => void = () => undefined
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls++
            await new Promise<void>((r) => {
              resolveBody = r
            })
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })

    const p1 = scheduler.invoke('sports', 'refresh_today')
    const p2 = scheduler.invoke('sports', 'refresh_today')
    expect(calls).toBe(1)

    resolveBody()
    await Promise.all([p1, p2])
    expect(calls).toBe(1)
  })
})

describe('failure tracking + staleness', () => {
  it('isFailing flips true after 3 consecutive failures', async () => {
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            throw new Error('upstream 503')
          },
        }),
      ],
      contextFactory: fakeCtx,
    })

    // Failure 1 — not yet failing
    await scheduler.invoke('sports', 'refresh_today')
    let s = scheduler.getStaleness('sports', 'refresh_today')
    expect(s.isFailing).toBe(false)
    expect(s.lastError).toMatch(/upstream 503/)

    // Failure 2
    await scheduler.invoke('sports', 'refresh_today')
    expect(scheduler.getStaleness('sports', 'refresh_today').isFailing).toBe(false)

    // Failure 3 — now failing
    await scheduler.invoke('sports', 'refresh_today')
    expect(scheduler.getStaleness('sports', 'refresh_today').isFailing).toBe(true)
  })

  it('successful run after failures resets streak and clears isFailing', async () => {
    let shouldFail = true
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            if (shouldFail) throw new Error('boom')
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })

    for (let i = 0; i < 3; i++) await scheduler.invoke('sports', 'refresh_today')
    expect(scheduler.getStaleness('sports', 'refresh_today').isFailing).toBe(true)

    shouldFail = false
    await scheduler.invoke('sports', 'refresh_today')
    const s = scheduler.getStaleness('sports', 'refresh_today')
    expect(s.isFailing).toBe(false)
    expect(s.lastError).toBeNull()
    expect(s.fetchedAt).toBeGreaterThan(0)
  })

  it('staleness.refresh() invokes the task and is dedup-aware', async () => {
    let calls = 0
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls++
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    const s = scheduler.getStaleness('sports', 'refresh_today')
    await s.refresh()
    expect(calls).toBe(1)
  })
})

describe('onTaskComplete callback', () => {
  it('fires after success with ok=true', async () => {
    const completions: { appId: string; taskId: string; ok: boolean }[] = []
    const scheduler = new RefreshScheduler({
      getMountedSet: () => mounted,
      onTaskComplete: (appId, taskId, ok) => completions.push({ appId, taskId, ok }),
    })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => undefined,
        }),
      ],
      contextFactory: fakeCtx,
    })
    await scheduler.invoke('sports', 'refresh_today')
    expect(completions).toEqual([{ appId: 'sports', taskId: 'refresh_today', ok: true }])
  })

  it('fires after failure with ok=false', async () => {
    const completions: { appId: string; taskId: string; ok: boolean }[] = []
    const scheduler = new RefreshScheduler({
      getMountedSet: () => mounted,
      onTaskComplete: (appId, taskId, ok) => completions.push({ appId, taskId, ok }),
    })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            throw new Error('x')
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    await scheduler.invoke('sports', 'refresh_today')
    expect(completions[0]?.ok).toBe(false)
  })

  it('skips onTaskComplete when fingerprint matches the prior tick', async () => {
    const completions: string[] = []
    const scheduler = new RefreshScheduler({
      getMountedSet: () => mounted,
      onTaskComplete: (_a, taskId) => completions.push(taskId),
    })
    let ticks = 0
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '15m',
          mountedOnly: false,
          warmup: false,
          // Tick 1: fingerprint='A' (no prior). Tick 2: fingerprint='A' (skip).
          // Tick 3: fingerprint='B' (notify again).
          run: async () => {
            ticks += 1
            return { fingerprint: ticks === 3 ? 'B' : 'A' }
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    await scheduler.invoke('sports', 'refresh_today')
    await scheduler.invoke('sports', 'refresh_today')
    await scheduler.invoke('sports', 'refresh_today')
    expect(ticks).toBe(3)
    expect(completions).toEqual(['refresh_today', 'refresh_today']) // tick 2 skipped
  })
})

describe('lifecycle', () => {
  it('unregisterApp stops timers and removes state', async () => {
    vi.useFakeTimers()
    mounted.push(mount('sports'))
    let calls = 0
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '1s',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls++
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)

    scheduler.unregisterApp('sports')
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(1)

    expect(() => scheduler.getStaleness('sports', 'refresh_today')).toThrow(/unknown task/)
    scheduler.stop()
  })

  it('stop() halts timers; start() resumes', async () => {
    vi.useFakeTimers()
    mounted.push(mount('sports'))
    let calls = 0
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerApp({
      appId: 'sports',
      tasks: [
        defineRefreshTask({
          id: 'refresh_today',
          every: '1s',
          mountedOnly: false,
          warmup: false,
          run: async () => {
            calls++
            return undefined
          },
        }),
      ],
      contextFactory: fakeCtx,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(2)

    scheduler.stop()
  })
})

describe('error handling on unknown task', () => {
  it.each([
    ['invoke', async (s: RefreshScheduler) => s.invoke('sports', 'nope')],
    [
      'getStaleness',
      (s: RefreshScheduler) => Promise.resolve().then(() => s.getStaleness('sports', 'nope')),
    ],
  ] as [string, (s: RefreshScheduler) => Promise<unknown>][])(
    '%s on unknown task throws',
    async (_, call) => {
      const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
      await expect(call(scheduler)).rejects.toThrow(/unknown task/)
    },
  )
})

// ---------------------------------------------------------------------------
// Face-bound refresh
// ---------------------------------------------------------------------------

function fakeFaceCtx(params: Record<string, unknown>): RefreshContext {
  return { ...fakeCtx(), params }
}

function gameMount(gameId: string, deviceId = 'phone'): MountedFaceEntry {
  return {
    deviceId,
    scope: 'app:sports',
    faceId: 'game',
    params: { game_id: gameId },
  }
}

describe('face-bound refresh: lifecycle', () => {
  it('spawns one worker per distinct (faceId, params) on mount', async () => {
    const calls: { gameId: string; calledAt: number }[] = []
    const refresh: FaceBoundRefresh = {
      every: '5s',
      warmup: true,
      run: async ({ params }) => {
        calls.push({ gameId: params!.game_id as string, calledAt: Date.now() })
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })

    mounted.push(gameMount('A'), gameMount('B'))
    scheduler.start()
    // warmup runs are awaited in the next tick of the event loop
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const gameIds = calls.map((c) => c.gameId).sort()
    expect(gameIds).toEqual(['A', 'B'])
    scheduler.stop()
  })

  it('dedupes workers across multiple devices viewing the same (faceId, params)', async () => {
    let calls = 0
    const refresh: FaceBoundRefresh = {
      every: '5s',
      warmup: true,
      run: async () => {
        calls++
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })

    // Phone + watch both viewing game(id=X) → ONE worker, ONE call.
    mounted.push(gameMount('X', 'phone'), gameMount('X', 'watch'))
    scheduler.start()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(calls).toBe(1)
    scheduler.stop()
  })

  it('reconciles: spawn new worker when params change, kill orphan', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const refresh: FaceBoundRefresh = {
      every: '60s',
      warmup: true,
      run: async ({ params }) => {
        calls.push(params!.game_id as string)
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })

    // Mount game(A)
    mounted.push(gameMount('A'))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve() // let warmup run
    await Promise.resolve()
    expect(calls).toEqual(['A'])

    // Switch to game(B) — A worker stops, B worker spawns
    mounted.length = 0
    mounted.push(gameMount('B'))
    scheduler.notifyMountedSetChanged()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['A', 'B'])

    // Advance time — should NOT see further calls for A
    await vi.advanceTimersByTimeAsync(120_000)
    const afterAdvance = calls.slice()
    // Future calls (for the still-running B worker) are fine; A should never appear again.
    expect(afterAdvance.filter((g) => g === 'A')).toHaveLength(1)
    scheduler.stop()
  })

  it('unmount stops worker; in-flight runs complete; no further ticks', async () => {
    vi.useFakeTimers()
    let started = 0
    let resolveBody: () => void = () => undefined
    const refresh: FaceBoundRefresh = {
      every: '1s',
      warmup: true,
      run: async () => {
        started++
        if (started === 1) {
          await new Promise<void>((r) => {
            resolveBody = r
          })
        }
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })
    mounted.push(gameMount('X'))
    scheduler.start()
    // Allow warmup run to begin
    await Promise.resolve()
    expect(started).toBe(1)

    // Unmount mid-flight; the in-flight body should still be allowed to finish
    mounted.length = 0
    scheduler.notifyMountedSetChanged()
    resolveBody()
    await vi.advanceTimersByTimeAsync(5_000)
    // No further runs scheduled after unmount
    expect(started).toBe(1)
    scheduler.stop()
  })

  it('invokeFace runs a specific (faceId, params) worker manually', async () => {
    let calls = 0
    const refresh: FaceBoundRefresh = {
      every: '60s',
      warmup: false,
      run: async () => {
        calls++
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })
    mounted.push(gameMount('X'))
    scheduler.start()
    // No warmup, so first call is via manual invokeFace
    await scheduler.invokeFace('sports', 'game', { game_id: 'X' })
    expect(calls).toBe(1)
    scheduler.stop()
  })

  it('invokeFace on unknown (faceId, params) throws', async () => {
    const refresh: FaceBoundRefresh = {
      every: '60s',
      run: async () => undefined,
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })
    scheduler.start()
    await expect(
      scheduler.invokeFace('sports', 'game', { game_id: 'never_mounted' }),
    ).rejects.toThrow(/no face-bound worker/)
    scheduler.stop()
  })
})

describe('face-bound refresh: parameters identity', () => {
  it('treats {a:1, b:2} and {b:2, a:1} as the same key (one worker)', async () => {
    let calls = 0
    const refresh: FaceBoundRefresh = {
      every: '60s',
      warmup: true,
      run: async () => {
        calls++
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })
    mounted.push(
      { deviceId: 'p', scope: 'app:sports', faceId: 'game', params: { a: 1, b: 2 } },
      { deviceId: 'w', scope: 'app:sports', faceId: 'game', params: { b: 2, a: 1 } },
    )
    scheduler.start()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(calls).toBe(1)
    scheduler.stop()
  })
})

describe('face-bound refresh: app unregister tears down workers', () => {
  it('unregisterApp stops all face-bound workers', async () => {
    vi.useFakeTimers()
    let calls = 0
    const refresh: FaceBoundRefresh = {
      every: '1s',
      warmup: false,
      run: async () => {
        calls++
      },
    }
    const scheduler = new RefreshScheduler({ getMountedSet: () => mounted })
    scheduler.registerFace({
      appId: 'sports',
      faceId: 'game',
      refresh,
      contextFactory: fakeFaceCtx,
    })
    mounted.push(gameMount('X'))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBeGreaterThan(0)
    const before = calls

    scheduler.unregisterApp('sports')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(before)
    scheduler.stop()
  })
})
