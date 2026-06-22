/**
 * `ctx.http` — HTTP client for refresh tasks and tools.
 *
 * Defaults: 10s timeout, 3 retries with exponential backoff (250/500/1000ms)
 * on 5xx + network errors. Per-host circuit breaker: 5 consecutive failures
 * trip the breaker for 60s; next call after cooldown is half-open. Per-app
 * token-bucket budget (`maxRequestsPerMinute`); overflow queues up to 10
 * callers then throws `BudgetExceededError`.
 *
 * Resolvers must NOT use this — I/O belongs only in tools and refresh tasks.
 */

import type { HttpClient, HttpFetchOptions } from '../agent/types.js'

export interface CreateHttpClientOptions {
  /** App id used for budget accounting and telemetry. */
  appId: string
  /** Per-minute request budget. Undefined = unbounded (development only). */
  maxRequestsPerMinute?: number
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly appId: string,
    public readonly retryAfterSec: number,
  ) {
    super(`upstream budget exceeded for app "${appId}"; retry after ${retryAfterSec}s`)
    this.name = 'BudgetExceededError'
  }
}

export class BreakerOpenError extends Error {
  constructor(
    public readonly host: string,
    public readonly retryAfterSec: number,
  ) {
    super(`circuit breaker open for host "${host}"; retry after ${retryAfterSec}s`)
    this.name = 'BreakerOpenError'
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 3
const RETRY_BASE_MS = 250
const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 60_000
const QUEUE_BOUND = 10
const QUEUE_POLL_MS = 100

interface BreakerState {
  consecutiveFailures: number
  openedAt: number | null
  /** True while a half-open probe is in flight — only one caller probes at a time. */
  halfOpenInFlight: boolean
}

interface BudgetState {
  tokens: number
  lastRefillAt: number
  capacity: number
  /** Pending callers waiting for tokens (bounded by QUEUE_BOUND). */
  queue: Array<() => void>
  /** Single drain timer; lazily started when queue becomes non-empty. */
  drainTimer: ReturnType<typeof setInterval> | null
}

/** Construct a per-app HTTP client with isolated breaker + budget state. */
export function createHttpClient(opts: CreateHttpClientOptions): HttpClient {
  const breakers = new Map<string, BreakerState>()

  const budget: BudgetState | null =
    opts.maxRequestsPerMinute && opts.maxRequestsPerMinute > 0
      ? {
          tokens: opts.maxRequestsPerMinute,
          lastRefillAt: Date.now(),
          capacity: opts.maxRequestsPerMinute,
          queue: [],
          drainTimer: null,
        }
      : null

  function refillBudget(): void {
    if (!budget) return
    const now = Date.now()
    const elapsedMs = now - budget.lastRefillAt
    if (elapsedMs <= 0) return
    const refill = (elapsedMs / 60_000) * budget.capacity
    budget.tokens = Math.min(budget.capacity, budget.tokens + refill)
    budget.lastRefillAt = now
  }

  function ensureDrainTimer(): void {
    if (!budget || budget.drainTimer !== null) return
    budget.drainTimer = setInterval(() => {
      refillBudget()
      // Drain as many waiters as we have tokens for.
      while (budget.queue.length > 0 && budget.tokens >= 1) {
        const next = budget.queue.shift()!
        budget.tokens -= 1
        next()
      }
      // Stop the timer when queue drains — restarted lazily on next enqueue.
      if (budget.queue.length === 0 && budget.drainTimer !== null) {
        clearInterval(budget.drainTimer)
        budget.drainTimer = null
      }
    }, QUEUE_POLL_MS)
    // Don't keep the event loop alive solely for the drain timer.
    budget.drainTimer.unref?.()
  }

  async function consumeBudgetToken(): Promise<void> {
    if (!budget) return
    refillBudget()
    if (budget.tokens >= 1) {
      budget.tokens -= 1
      return
    }
    if (budget.queue.length >= QUEUE_BOUND) {
      const secPerToken = 60 / budget.capacity
      throw new BudgetExceededError(opts.appId, Math.ceil(secPerToken))
    }
    return new Promise<void>((resolve) => {
      budget.queue.push(resolve)
      ensureDrainTimer()
    })
  }

  function getBreaker(host: string): BreakerState {
    let b = breakers.get(host)
    if (!b) {
      b = { consecutiveFailures: 0, openedAt: null, halfOpenInFlight: false }
      breakers.set(host, b)
    }
    return b
  }

  function checkBreaker(host: string): void {
    const b = getBreaker(host)
    if (b.openedAt === null) return
    const sinceOpen = Date.now() - b.openedAt
    if (sinceOpen < BREAKER_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((BREAKER_COOLDOWN_MS - sinceOpen) / 1000)
      throw new BreakerOpenError(host, retryAfterSec)
    }
    // Cooldown elapsed — only one probe is allowed at a time.
    if (b.halfOpenInFlight) {
      throw new BreakerOpenError(host, 1)
    }
    b.halfOpenInFlight = true
  }

  function recordSuccess(host: string): void {
    const b = getBreaker(host)
    b.consecutiveFailures = 0
    b.openedAt = null
    b.halfOpenInFlight = false
  }

  function recordFailure(host: string): void {
    const b = getBreaker(host)
    b.consecutiveFailures += 1
    if (b.halfOpenInFlight) {
      // Half-open probe failed — re-open with a fresh cooldown.
      b.halfOpenInFlight = false
      b.openedAt = Date.now()
      return
    }
    if (b.consecutiveFailures >= BREAKER_THRESHOLD && b.openedAt === null) {
      b.openedAt = Date.now()
    }
  }

  /** Caller-initiated abort: not a server failure, but releases the half-open slot. */
  function recordAbort(host: string): void {
    const b = getBreaker(host)
    b.halfOpenInFlight = false
  }

  return {
    async fetch(url: string, fetchOpts?: HttpFetchOptions): Promise<Response> {
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        throw new Error(`http-client: invalid URL: ${url}`)
      }

      checkBreaker(host)
      await consumeBudgetToken()

      const timeoutMs = fetchOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const retries = fetchOpts?.retries ?? DEFAULT_RETRIES

      let lastError: Error | undefined
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1)
          await new Promise((r) => setTimeout(r, delay))
          // Previous attempt may have tripped the breaker.
          checkBreaker(host)
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
        const externalSignal = fetchOpts?.signal
        const onExternalAbort = (): void => controller.abort(externalSignal?.reason)
        externalSignal?.addEventListener('abort', onExternalAbort)

        // Cleanup on every exit path (success, 5xx-retry, throw) to avoid
        // leaking an event listener per retried response.
        try {
          const init: RequestInit = { signal: controller.signal }
          if (fetchOpts?.method) init.method = fetchOpts.method
          if (fetchOpts?.headers) init.headers = fetchOpts.headers
          if (fetchOpts?.body !== undefined) init.body = fetchOpts.body

          try {
            const res = await fetch(url, init)

            if (res.status >= 500 && res.status < 600) {
              recordFailure(host)
              if (attempt < retries) {
                lastError = new Error(`HTTP ${res.status}`)
                continue
              }
              // Out of retries — return the response so caller can handle.
              return res
            }

            // 4xx is a client error, not a server failure — don't trip the breaker.
            recordSuccess(host)
            return res
          } catch (err) {
            // Caller-signal aborts don't trip the breaker.
            if (externalSignal?.aborted) {
              recordAbort(host)
              throw err instanceof Error ? err : new Error(String(err))
            }
            recordFailure(host)
            lastError = err instanceof Error ? err : new Error(String(err))
            if (attempt < retries) continue
            throw lastError
          }
        } finally {
          clearTimeout(timer)
          externalSignal?.removeEventListener('abort', onExternalAbort)
        }
      }
      throw lastError ?? new Error('http-client: unreachable')
    },
  }
}
