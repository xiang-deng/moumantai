/**
 * EventQueue — async bridge between an SDK's background turn and the
 * adapter's AsyncIterable contract.
 *
 * Used by the Claude adapter and (next) the Pi adapter. Both SDKs run their
 * own agent loop in the background and push events at us out-of-band; this
 * queue lets `run()` yield them as an AsyncIterable.
 *
 * Push is a no-op after close — both abort and the background runner race to
 * end the queue, and late events on a closed queue should drop silently
 * rather than accumulate in a buffer nobody is iterating.
 */
export class EventQueue<T> {
  private buffer: T[] = []
  private waiter: ((value: IteratorResult<T, undefined>) => void) | null = null
  private closed = false

  push(value: T): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  /** Idempotent close. Safe to call from both the abort handler and the
   *  background runner's finally block without coordination. */
  end(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}
