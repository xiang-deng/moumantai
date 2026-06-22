import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveAssetUrl } from '../../src/transport/asset-url'

const SERVER_URL_KEY = 'moumantai.serverUrl'

describe('resolveAssetUrl', () => {
  beforeEach(() => {
    localStorage.removeItem(SERVER_URL_KEY)
  })
  afterEach(() => {
    localStorage.removeItem(SERVER_URL_KEY)
  })

  it('rewrites server-relative paths using the configured server URL', () => {
    localStorage.setItem(SERVER_URL_KEY, 'ws://localhost:3000')
    expect(resolveAssetUrl('/apps/spend/assets/icon.png')).toBe(
      'http://localhost:3000/apps/spend/assets/icon.png',
    )
  })

  it('maps wss:// to https:// for production-style URLs', () => {
    localStorage.setItem(SERVER_URL_KEY, 'wss://moumantai.example.ts.net')
    expect(resolveAssetUrl('/apps/scoreboard/assets/x.png')).toBe(
      'https://moumantai.example.ts.net/apps/scoreboard/assets/x.png',
    )
  })

  it('passes absolute URLs through unchanged', () => {
    localStorage.setItem(SERVER_URL_KEY, 'ws://localhost:3000')
    expect(resolveAssetUrl('https://example.com/image.png')).toBe('https://example.com/image.png')
  })

  it('returns undefined when src is undefined', () => {
    expect(resolveAssetUrl(undefined)).toBeUndefined()
  })

  it('falls back to VITE_WS_URL when no localStorage override is set', () => {
    // `.env.development` in this workspace sets VITE_WS_URL=ws://localhost:3000.
    // Production builds omit it; same-origin fallback kicks in there.
    expect(resolveAssetUrl('/apps/x.png')).toBe('http://localhost:3000/apps/x.png')
  })
})
