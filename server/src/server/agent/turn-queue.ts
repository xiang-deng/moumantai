/**
 * TurnQueue — serializes user turns per conversation.
 *
 * Keyed on `conversationId`, so two devices viewing the same scope serialize
 * their turns through the same queue. Each running task receives an
 * `AbortSignal` that fires when `abort(key)` is called — that's how the
 * `resetConversation` flow cancels in-flight tool execution, and how app
 * eviction forces draining.
 *
 * If a new turn arrives while one is running, it is enqueued. Pending entries
 * are rejected with `aborted` on `abort(key)`; the running entry's task sees
 * the signal fire and is expected to unwind cleanly.
 */

export interface TurnTask<T> {
  /** The signal fires when `abort(key)` is called while this task is running. */
  run: (signal: AbortSignal) => Promise<T>
}

interface QueueEntry {
  run: (signal: AbortSignal) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class TurnQueue {
  private queues = new Map<string, QueueEntry[]>()
  private running = new Map<string, AbortController>()
  /** Per-key promises that resolve when drain(key) should wake up. */
  private drainWaiters = new Map<string, Array<() => void>>()
  private readonly maxDepth: number

  constructor(maxDepth = 5) {
    this.maxDepth = maxDepth
  }

  /** Queue size for a key (including the currently running turn, if any). */
  size(key: string): number {
    return (this.running.has(key) ? 1 : 0) + (this.queues.get(key)?.length ?? 0)
  }

  /** True if a task is running or pending for this key. */
  hasPending(key: string): boolean {
    return this.running.has(key) || (this.queues.get(key)?.length ?? 0) > 0
  }

  /**
   * Enqueue a turn. If no turn is running for this key, it starts immediately.
   *
   * The task's `run` receives an AbortSignal that fires when `abort(key)` is
   * invoked — callers should plumb this into any downstream cancellable work
   * (SDK query, tool handlers, etc.).
   *
   * @throws 'session_busy' if the queue depth would exceed maxDepth.
   */
  async enqueue<T>(key: string, task: TurnTask<T>): Promise<T> {
    const queue = this.queues.get(key) ?? []
    if (!this.queues.has(key)) this.queues.set(key, queue)

    const depth = (this.running.has(key) ? 1 : 0) + queue.length
    if (depth >= this.maxDepth) {
      const err = new Error('session_busy')
      err.name = 'SessionBusyError'
      throw err
    }

    return new Promise<T>((resolve, reject) => {
      queue.push({
        run: task.run as (signal: AbortSignal) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      if (!this.running.has(key)) {
        void this.runNext(key)
      }
    })
  }

  /**
   * Abort everything for a key:
   *  - rejects every pending (not-yet-started) entry with `aborted`
   *  - fires the AbortSignal on the currently running entry (if any) so its
   *    task can unwind cleanly
   *
   * Does not wait — use `drain(key)` if you need to block until the queue
   * (and the currently running task) are actually done.
   */
  abort(key: string): void {
    const queue = this.queues.get(key) ?? []
    for (const entry of queue) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      entry.reject(err)
    }
    this.queues.delete(key)

    const controller = this.running.get(key)
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Resolve when no task is running OR pending for this key. If the queue is
   * already idle, resolves synchronously on the microtask tick.
   */
  async drain(key: string): Promise<void> {
    if (!this.hasPending(key)) return
    await new Promise<void>((resolve) => {
      const waiters = this.drainWaiters.get(key) ?? []
      waiters.push(resolve)
      this.drainWaiters.set(key, waiters)
    })
  }

  private async runNext(key: string): Promise<void> {
    if (this.running.has(key)) return
    const queue = this.queues.get(key)
    if (!queue || queue.length === 0) {
      this.queues.delete(key)
      this.notifyDrain(key)
      return
    }

    const controller = new AbortController()
    this.running.set(key, controller)
    const entry = queue.shift()!
    try {
      const result = await entry.run(controller.signal)
      entry.resolve(result)
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.running.delete(key)
      if (this.queues.get(key)?.length) {
        void this.runNext(key)
      } else {
        this.queues.delete(key)
        this.notifyDrain(key)
      }
    }
  }

  private notifyDrain(key: string): void {
    const waiters = this.drainWaiters.get(key)
    if (!waiters || waiters.length === 0) return
    this.drainWaiters.delete(key)
    for (const w of waiters) {
      try {
        w()
      } catch {
        /* ignore */
      }
    }
  }
}
