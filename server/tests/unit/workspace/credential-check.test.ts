import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkAnthropicCredential } from '../../../src/server/workspace/credential-check.js'

interface CapturedCall {
  url: string
  headers: Record<string, string>
}

/** Stub global fetch; capture each call's URL + headers; return the given status. */
function stubFetch(status: number): CapturedCall[] {
  const calls: CapturedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} })
      return { ok: status >= 200 && status < 300, status } as unknown as Response
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkAnthropicCredential — header dispatch', () => {
  // Regression: OAuth tokens (`sk-ant-oat…`) start with `sk-`, so the old
  // `startsWith('sk-')` check sent them as `x-api-key` → 401, making a VALID
  // token look invalid. They must go out as `Authorization: Bearer`.
  it('OAuth token (sk-ant-oat…) authenticates via Authorization: Bearer, never x-api-key', async () => {
    const calls = stubFetch(200)
    const res = await checkAnthropicCredential('sk-ant-oat01-EXAMPLE')

    expect(res).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('api.anthropic.com/v1/models')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-ant-oat01-EXAMPLE')
    expect(calls[0]!.headers['x-api-key']).toBeUndefined()
  })

  // Old behavior must still hold: console API keys use `x-api-key`.
  it('API key (sk-ant-api…) authenticates via x-api-key, never Authorization', async () => {
    const calls = stubFetch(200)
    const res = await checkAnthropicCredential('sk-ant-api-EXAMPLE')

    expect(res).toEqual({ ok: true })
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-api-EXAMPLE')
    expect(calls[0]!.headers['Authorization']).toBeUndefined()
  })

  it('trims surrounding whitespace before dispatching', async () => {
    const calls = stubFetch(200)
    await checkAnthropicCredential('  sk-ant-oat01-EXAMPLE  ')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-ant-oat01-EXAMPLE')
  })

  it('maps 401 to a friendly auth error', async () => {
    stubFetch(401)
    const res = await checkAnthropicCredential('sk-ant-oat01-EXAMPLE')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Authentication failed/)
  })

  it('rejects an empty credential without calling the network', async () => {
    const calls = stubFetch(200)
    const res = await checkAnthropicCredential('   ')
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
