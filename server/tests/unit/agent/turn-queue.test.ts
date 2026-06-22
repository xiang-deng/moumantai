/**
 * Unit tests for the per-conversation TurnQueue.
 *
 * Covers:
 *  - FIFO order on back-to-back enqueues (same key)
 *  - queue depth cap → session_busy
 *  - abort(key) rejects pending turns and fires the running task's AbortSignal
 *  - independent queues per key
 *  - hasPending / drain primitives used by the app-eviction sweep
 */

import { describe, it, expect } from 'vitest'
import { TurnQueue } from '../../../src/server/agent/turn-queue.js'

function deferred<T = unknown>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('TurnQueue', () => {
  it('runs turns FIFO on a single conversation', async () => {
    const queue = new TurnQueue(5)
    const log: string[] = []

    const gate1 = deferred()
    const gate2 = deferred()
    const gate3 = deferred()

    const t1 = queue.enqueue('c1', {
      run: async () => {
        log.push('t1-start')
        await gate1.promise
        log.push('t1-end')
        return 1
      },
    })
    const t2 = queue.enqueue('c1', {
      run: async () => {
        log.push('t2-start')
        await gate2.promise
        log.push('t2-end')
        return 2
      },
    })
    const t3 = queue.enqueue('c1', {
      run: async () => {
        log.push('t3-start')
        await gate3.promise
        log.push('t3-end')
        return 3
      },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(log).toEqual(['t1-start'])

    gate1.resolve(undefined)
    await new Promise((r) => setTimeout(r, 10))
    expect(log).toEqual(['t1-start', 't1-end', 't2-start'])

    gate2.resolve(undefined)
    await new Promise((r) => setTimeout(r, 10))
    expect(log).toEqual(['t1-start', 't1-end', 't2-start', 't2-end', 't3-start'])

    gate3.resolve(undefined)
    await Promise.all([t1, t2, t3])
    expect(log).toEqual(['t1-start', 't1-end', 't2-start', 't2-end', 't3-start', 't3-end'])
  })

  it('rejects immediately with SessionBusyError when depth exceeds maxDepth', async () => {
    const queue = new TurnQueue(2)
    const g1 = deferred()
    const g2 = deferred()

    const t1 = queue.enqueue('c1', {
      run: async () => {
        await g1.promise
      },
    })
    const t2 = queue.enqueue('c1', {
      run: async () => {
        await g2.promise
      },
    })

    await expect(queue.enqueue('c1', { run: async () => {} })).rejects.toMatchObject({
      message: 'session_busy',
    })

    g1.resolve(undefined)
    g2.resolve(undefined)
    await Promise.all([t1, t2])
  })

  it("abort(key) rejects pending turns and fires the running task's AbortSignal", async () => {
    const queue = new TurnQueue(5)
    const g1 = deferred()
    let signaled = false

    const t1 = queue.enqueue('c1', {
      run: async (signal) => {
        signal.addEventListener('abort', () => {
          signaled = true
        })
        await g1.promise
        return 'done-t1'
      },
    })
    const t2 = queue.enqueue('c1', { run: async () => 'done-t2' })
    const t3 = queue.enqueue('c1', { run: async () => 'done-t3' })

    // Let t1 subscribe to the signal before we abort.
    await tick()
    queue.abort('c1')

    await expect(t2).rejects.toThrow(/aborted/)
    await expect(t3).rejects.toThrow(/aborted/)
    expect(signaled).toBe(true)

    // Task body still decides whether to unwind — ours ignores the signal
    // and waits on the gate. It should still resolve with its own return.
    g1.resolve(undefined)
    await expect(t1).resolves.toBe('done-t1')
  })

  it('maintains independent queues per key', async () => {
    const queue = new TurnQueue(5)
    const log: string[] = []
    const gA = deferred()
    const gB = deferred()

    const a = queue.enqueue('convA', {
      run: async () => {
        log.push('A')
        await gA.promise
      },
    })
    const b = queue.enqueue('convB', {
      run: async () => {
        log.push('B')
        await gB.promise
      },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(log.sort()).toEqual(['A', 'B'])

    gA.resolve(undefined)
    gB.resolve(undefined)
    await Promise.all([a, b])

    expect(queue.size('convA')).toBe(0)
    expect(queue.size('convB')).toBe(0)
  })

  describe('hasPending / drain', () => {
    it('hasPending tracks running + pending state', async () => {
      const q = new TurnQueue()
      expect(q.hasPending('c1')).toBe(false)
      const g = deferred()
      const p = q.enqueue('c1', {
        run: async () => {
          await g.promise
        },
      })
      expect(q.hasPending('c1')).toBe(true)
      g.resolve(undefined)
      await p
      expect(q.hasPending('c1')).toBe(false)
    })

    it('drain resolves immediately when idle', async () => {
      const q = new TurnQueue()
      await q.drain('c1')
    })

    it('drain resolves after running and pending complete', async () => {
      const q = new TurnQueue()
      let completed = 0
      q.enqueue('c1', {
        run: async () => {
          await tick()
          completed++
        },
      })
      q.enqueue('c1', {
        run: async () => {
          await tick()
          completed++
        },
      })
      await q.drain('c1')
      expect(completed).toBe(2)
      expect(q.hasPending('c1')).toBe(false)
    })

    it('drain resolves once abort unwinds a signal-aware task', async () => {
      const q = new TurnQueue()
      const running = q.enqueue('c1', {
        run: async (signal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => resolve('bailed'))
          }),
      })
      q.enqueue('c1', { run: async () => 'never' }).catch(() => {
        /* expected */
      })
      await tick()
      q.abort('c1')
      await q.drain('c1')
      await expect(running).resolves.toBe('bailed')
    })
  })
})
