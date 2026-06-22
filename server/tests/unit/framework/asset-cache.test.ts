import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createAssetCache,
  assetPath,
  tryServeAssetRequest,
} from '../../../src/server/framework/asset-cache.js'
import type { HttpClient } from '../../../src/server/agent/types.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'moumantai-assets-'))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

function fakeHttp(impl: (url: string) => Promise<Response>): HttpClient {
  return { fetch: async (url: string) => impl(url) }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('createAssetCache: fetch + persist', () => {
  it('fetches once on cache miss and writes the file', async () => {
    let calls = 0
    const http = fakeHttp(async () => {
      calls++
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const cache = createAssetCache({ appId: 'sports', home: tmpHome, http })

    const url = 'https://a.example.com/team.png'
    const webPath = await cache(url)
    expect(webPath).toMatch(/^\/apps\/sports\/assets\/[0-9a-f]{16}\.png$/)
    expect(calls).toBe(1)

    const { diskPath } = assetPath(tmpHome, 'sports', url)
    expect(existsSync(diskPath)).toBe(true)
    const persisted = await fs.readFile(diskPath)
    expect(Buffer.from(persisted).equals(Buffer.from(PNG_BYTES))).toBe(true)
  })

  it('returns cached URL without refetching on hit', async () => {
    let calls = 0
    const http = fakeHttp(async () => {
      calls++
      return new Response(PNG_BYTES, { status: 200 })
    })
    const cache = createAssetCache({ appId: 'sports', home: tmpHome, http })

    const url = 'https://a.example.com/x.png'
    const a = await cache(url)
    const b = await cache(url)
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  it('throws when upstream returns non-2xx', async () => {
    const http = fakeHttp(async () => new Response('nope', { status: 404 }))
    const cache = createAssetCache({ appId: 'sports', home: tmpHome, http })
    await expect(cache('https://a.example.com/missing.png')).rejects.toThrow(/404/)
  })

  it('uses content-type when URL extension is missing', async () => {
    const http = fakeHttp(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const cache = createAssetCache({ appId: 'sports', home: tmpHome, http })
    const webPath = await cache('https://a.example.com/some-logo-no-ext')
    expect(webPath).toMatch(/\.png$/)
  })
})

describe('tryServeAssetRequest', () => {
  it('serves an existing asset with the right Content-Type', async () => {
    // Write a fake asset file
    const dir = path.join(tmpHome, 'apps', 'sports', 'assets')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '1234567890abcdef.png'), Buffer.from(PNG_BYTES))

    let writtenStatus = 0
    let writtenHeaders: Record<string, string> | undefined
    let writtenBody: Buffer | string | undefined
    const res = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        writtenStatus = status
        writtenHeaders = headers
      },
      end: (body?: Buffer | string) => {
        writtenBody = body
      },
    }

    const handled = await tryServeAssetRequest({
      home: tmpHome,
      url: '/apps/sports/assets/1234567890abcdef.png',
      res,
    })
    expect(handled).toBe(true)
    expect(writtenStatus).toBe(200)
    expect(writtenHeaders?.['Content-Type']).toBe('image/png')
    expect(Buffer.isBuffer(writtenBody)).toBe(true)
    expect((writtenBody as Buffer).equals(Buffer.from(PNG_BYTES))).toBe(true)
  })

  it('returns 404 when file does not exist', async () => {
    let writtenStatus = 0
    const res = {
      writeHead: (status: number) => {
        writtenStatus = status
      },
      end: () => undefined,
    }
    const handled = await tryServeAssetRequest({
      home: tmpHome,
      url: '/apps/sports/assets/nope.png',
      res,
    })
    expect(handled).toBe(true)
    expect(writtenStatus).toBe(404)
  })

  it('returns false (does not match) for non-asset URLs', async () => {
    const res = { writeHead: () => undefined, end: () => undefined }
    const handled = await tryServeAssetRequest({
      home: tmpHome,
      url: '/some/other/path',
      res,
    })
    expect(handled).toBe(false)
  })

  it.each([
    // URL-encoded slash inside the filename: regex matches it as one segment,
    // defense-in-depth check on '..' substring rejects with 400.
    ['/apps/sports/assets/..%2Fevil', 400, true],
    // Literal '..' in the filename — same defense-in-depth path.
    ['/apps/sports/assets/..hidden', 400, true],
    // Backslash (Windows separator) — defense-in-depth.
    ['/apps/sports/assets/foo\\bar', 400, true],
    // Forward slash — regex `[^\/]+` rejects up front, no match.
    ['/apps/sports/assets/sub/path.png', null, false],
    // Path-traversal via additional `/..` after assets — no match.
    ['/apps/sports/assets/../../etc/passwd', null, false],
  ])('rejects %s with status %s (handled=%s)', async (url, expectedStatus, handledExpected) => {
    let writtenStatus: number | null = null
    let bodyWritten = false
    const res = {
      writeHead: (status: number) => {
        writtenStatus = status
      },
      end: (body?: unknown) => {
        if (body !== undefined) bodyWritten = true
      },
    }
    const handled = await tryServeAssetRequest({ home: tmpHome, url, res })
    expect(handled).toBe(handledExpected)
    if (handledExpected) expect(writtenStatus).toBe(expectedStatus)
    // Critical invariant: never serve a body for any traversal attempt.
    expect(bodyWritten).toBe(false)
  })
})
