import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getEventListeners } from 'node:events'
import {
  createHttpClient,
  BudgetExceededError,
  BreakerOpenError,
} from '../../../src/server/framework/http-client.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof globalThis.fetch
}

function ok(body = 'ok', status = 200): Response {
  return new Response(body, { status })
}

function err(status = 500, body = 'boom'): Response {
  return new Response(body, { status })
}

describe('http-client: success path', () => {
  it('returns the response unchanged on 2xx', async () => {
    mockFetch(async () => ok('hello'))
    const client = createHttpClient({ appId: 'test' })
    const res = await client.fetch('https://example.com/x')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })

  it('passes method/headers/body through', async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    mockFetch(async (url, init) => {
      captured = { url, init }
      return ok()
    })
    const client = createHttpClient({ appId: 'test' })
    await client.fetch('https://example.com/x', {
      method: 'POST',
      headers: { 'X-Foo': 'bar' },
      body: 'payload',
    })
    expect(captured!.url).toBe('https://example.com/x')
    expect(captured!.init?.method).toBe('POST')
    expect(captured!.init?.headers).toMatchObject({ 'X-Foo': 'bar' })
    expect(captured!.init?.body).toBe('payload')
  })

  it('rejects malformed URLs early', async () => {
    const client = createHttpClient({ appId: 'test' })
    await expect(client.fetch('not a url')).rejects.toThrow(/invalid URL/)
  })
})

describe('http-client: retry on 5xx', () => {
  it('retries 5xx responses up to retries count', async () => {
    let calls = 0
    mockFetch(async () => {
      calls++
      return calls < 3 ? err(503) : ok('finally')
    })
    const client = createHttpClient({ appId: 'test' })
    const res = await client.fetch('https://example.com/x', { retries: 3 })
    expect(calls).toBe(3)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('finally')
  })

  it('returns the last response when retries exhausted on 5xx', async () => {
    mockFetch(async () => err(500))
    const client = createHttpClient({ appId: 'test' })
    const res = await client.fetch('https://example.com/x', { retries: 1 })
    expect(res.status).toBe(500)
  })

  it('does not retry on 4xx', async () => {
    let calls = 0
    mockFetch(async () => {
      calls++
      return err(404, 'not found')
    })
    const client = createHttpClient({ appId: 'test' })
    const res = await client.fetch('https://example.com/x', { retries: 3 })
    expect(calls).toBe(1)
    expect(res.status).toBe(404)
  })
})

describe('http-client: timeout', () => {
  it('aborts when timeoutMs elapses', async () => {
    mockFetch(async (_url, init) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
      return ok()
    })
    const client = createHttpClient({ appId: 'test' })
    await expect(
      client.fetch('https://example.com/x', { timeoutMs: 50, retries: 0 }),
    ).rejects.toThrow()
  })
})

describe('http-client: circuit breaker', () => {
  it('opens after 5 consecutive 5xx and fails fast subsequently', async () => {
    mockFetch(async () => err(500))
    const client = createHttpClient({ appId: 'test' })

    // Five failing calls (each with retries=0 to count 1-per-call against breaker).
    for (let i = 0; i < 5; i++) {
      const res = await client.fetch('https://flaky.example/y', { retries: 0 })
      expect(res.status).toBe(500)
    }

    // Sixth call should fail fast — breaker open.
    await expect(client.fetch('https://flaky.example/y', { retries: 0 })).rejects.toBeInstanceOf(
      BreakerOpenError,
    )
  })

  it('keeps separate breaker state per host', async () => {
    let healthyCalls = 0
    mockFetch(async (url) => {
      if (url.includes('flaky')) return err(500)
      healthyCalls++
      return ok()
    })
    const client = createHttpClient({ appId: 'test' })

    for (let i = 0; i < 5; i++) {
      await client.fetch('https://flaky.example/x', { retries: 0 })
    }
    await expect(client.fetch('https://flaky.example/x', { retries: 0 })).rejects.toBeInstanceOf(
      BreakerOpenError,
    )

    // Healthy host unaffected.
    const res = await client.fetch('https://healthy.example/x', { retries: 0 })
    expect(res.status).toBe(200)
    expect(healthyCalls).toBe(1)
  })

  it('successful response resets failure counter', async () => {
    let calls = 0
    mockFetch(async () => {
      calls++
      // 4 failures, 1 success, then keep failing — should NOT trip breaker
      // because the success reset the counter to 0.
      if (calls === 5) return ok()
      return err(500)
    })
    const client = createHttpClient({ appId: 'test' })

    for (let i = 0; i < 8; i++) {
      try {
        await client.fetch('https://x.example/x', { retries: 0 })
      } catch {
        /* fine */
      }
    }

    // Counter was reset by call 5; calls 6-8 contribute 3 failures (under threshold).
    // So no BreakerOpenError yet — verify by attempting a 9th call.
    mockFetch(async () => err(500))
    const res = await client.fetch('https://x.example/x', { retries: 0 })
    expect(res.status).toBe(500) // not BreakerOpenError
  })
})

describe('http-client: per-app budget', () => {
  it('throws BudgetExceededError when queue overflows', async () => {
    mockFetch(async () => ok())
    // Budget 1/min: bucket has 1 token, refills at 1/min (well over test time).
    const client = createHttpClient({ appId: 'test', maxRequestsPerMinute: 1 })

    // 1st call consumes the only token.
    await client.fetch('https://example.com/a', { retries: 0 })

    // Fill the queue (QUEUE_BOUND=10). Don't await — they'll hang waiting for token
    // refill. Tag .catch to suppress unhandled-rejection warnings.
    for (let i = 0; i < 10; i++) {
      client.fetch(`https://example.com/q${i}`, { retries: 0 }).catch(() => undefined)
    }

    // 11th request: queue full → throw synchronously.
    await expect(
      client.fetch('https://example.com/overflow', { retries: 0 }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('does not enforce budget when maxRequestsPerMinute is undefined', async () => {
    mockFetch(async () => ok())
    const client = createHttpClient({ appId: 'test' })
    // Many concurrent calls, no budget exhaustion expected.
    const proms = Array.from({ length: 20 }, (_, i) =>
      client.fetch(`https://example.com/x${i}`, { retries: 0 }),
    )
    const results = await Promise.all(proms)
    expect(results.every((r) => r.status === 200)).toBe(true)
  })
})

describe('http-client: external AbortSignal', () => {
  it('respects external signal and does not trip the breaker', async () => {
    mockFetch(async (_url, init) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
      return ok()
    })
    const client = createHttpClient({ appId: 'test' })

    const ctrl = new AbortController()
    const promise = client.fetch('https://noflaky.example/x', {
      signal: ctrl.signal,
      retries: 0,
    })
    setTimeout(() => ctrl.abort(), 10)
    await expect(promise).rejects.toThrow()

    // Subsequent call should NOT see BreakerOpenError — caller-initiated abort
    // doesn't count as a server failure.
    mockFetch(async () => ok())
    const res = await client.fetch('https://noflaky.example/y', { retries: 0 })
    expect(res.status).toBe(200)
  })

  it('does not leak abort listeners across 5xx retries', async () => {
    // Regression: each retry must removeEventListener its per-attempt closure,
    // or sustained 5xx outages drip memory (one closure per retried call).
    let calls = 0
    mockFetch(async () => {
      calls++
      return calls < 4 ? err(503) : ok()
    })
    const client = createHttpClient({ appId: 'test' })
    const ctrl = new AbortController()

    const before = getEventListeners(ctrl.signal, 'abort').length
    const res = await client.fetch('https://retry.example/x', {
      signal: ctrl.signal,
      retries: 3,
    })
    const after = getEventListeners(ctrl.signal, 'abort').length

    expect(calls).toBe(4)
    expect(res.status).toBe(200)
    expect(after).toBe(before) // every per-attempt listener removed
  })
})
