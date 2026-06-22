/**
 * `ctx.cacheAsset` — URL-keyed per-app asset cache.
 *
 * Given an upstream URL (e.g. a team logo PNG), fetch once and store at
 * `<home>/apps/<appId>/assets/<sha256-prefix>.<ext>`. Subsequent calls for
 * the same URL return the local path without refetching. Served at
 * `/apps/<appId>/assets/<file>` via the static route in `main.ts`.
 *
 * Hash: sha256 of the URL string, first 16 hex chars. URL-keyed (not
 * content-keyed): the same image at two URLs is cached twice; a changed
 * image at the same URL serves stale until `app cache-clear`. No automatic
 * eviction — `task server:cli -- app cache-clear <id>` wipes the assets dir.
 */

import { createHash } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { appPaths } from '../workspace/home.js'
import type { HttpClient } from '../agent/types.js'

export interface CreateAssetCacheOptions {
  appId: string
  /** Moumantai home dir; assets land in `<home>/apps/<appId>/assets/`. */
  home: string
  /** HTTP client to fetch assets through (counts against per-app budget). */
  http: HttpClient
}

const HASH_LEN = 16

/** Resolve the on-disk path for an asset given its URL (does not fetch). */
export function assetPath(
  home: string,
  appId: string,
  url: string,
): {
  diskPath: string
  webPath: string
  hash: string
  ext: string
} {
  const hash = sha256Hex(url).slice(0, HASH_LEN)
  const ext = extFromUrl(url)
  const filename = `${hash}${ext}`
  const root = path.join(appPaths(home, appId).root, 'assets')
  return {
    diskPath: path.join(root, filename),
    webPath: `/apps/${appId}/assets/${filename}`,
    hash,
    ext,
  }
}

/**
 * Build an asset-caching function bound to a particular app's directory.
 * Returns the function with the signature `ctx.cacheAsset` expects.
 */
export function createAssetCache(opts: CreateAssetCacheOptions): (url: string) => Promise<string> {
  const root = path.join(appPaths(opts.home, opts.appId).root, 'assets')

  return async function cacheAsset(url: string): Promise<string> {
    const { diskPath, webPath, ext } = assetPath(opts.home, opts.appId, url)

    // Cache hit — return the existing local URL.
    if (existsSync(diskPath)) {
      return webPath
    }

    // Miss — fetch and persist atomically.
    await fs.mkdir(root, { recursive: true })

    const res = await opts.http.fetch(url)
    if (!res.ok) {
      throw new Error(`cacheAsset: upstream returned ${res.status} for ${url}`)
    }

    const body = Buffer.from(await res.arrayBuffer())

    // Prefer Content-Type extension when the URL had the wrong one.
    const ctExt = extFromContentType(res.headers.get('content-type'))
    const finalDiskPath =
      ctExt && ctExt !== ext ? path.join(root, path.basename(diskPath, ext) + ctExt) : diskPath
    const finalWebPath =
      ctExt && ctExt !== ext ? webPath.replace(new RegExp(`${escapeRegex(ext)}$`), ctExt) : webPath

    // Write atomically (write .tmp, then rename) to survive mid-write crashes.
    const tmpPath = `${finalDiskPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmpPath, body)
    await fs.rename(tmpPath, finalDiskPath)

    return finalWebPath
  }
}

// -----------------------------------------------------------------------------
// Static route helper
// -----------------------------------------------------------------------------

/**
 * Serve `/apps/<appId>/assets/<file>` from disk. Returns true if matched
 * (response written); false if the URL didn't match the asset-route pattern.
 * `<file>` must be a single basename (no slashes) — anything else 404s.
 */
export async function tryServeAssetRequest(args: {
  home: string
  url: string
  res: {
    writeHead: (status: number, headers?: Record<string, string>) => void
    end: (body?: Buffer | string) => void
  }
}): Promise<boolean> {
  // Match `/apps/<appId>/assets/<file>` exactly.
  const match = /^\/apps\/([a-z][a-z0-9-]*)\/assets\/([^\/]+)$/.exec(args.url)
  if (!match) return false

  const appId = match[1]!
  const file = match[2]!
  // Defense in depth: reject traversal markers even if the regex let them through.
  if (file.includes('..') || file.includes('/') || file.includes('\\')) {
    args.res.writeHead(400)
    args.res.end()
    return true
  }

  const diskPath = path.join(appPaths(args.home, appId).root, 'assets', file)
  if (!existsSync(diskPath)) {
    args.res.writeHead(404)
    args.res.end()
    return true
  }

  try {
    const body = await fs.readFile(diskPath)
    const ext = path.extname(file).toLowerCase()
    args.res.writeHead(200, {
      'Content-Type': contentTypeFromExt(ext),
      'Content-Length': String(body.length),
      'Cache-Control': 'public, max-age=86400',
    })
    args.res.end(body)
  } catch {
    args.res.writeHead(500)
    args.res.end()
  }
  return true
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const dot = pathname.lastIndexOf('.')
    if (dot === -1 || dot < pathname.lastIndexOf('/')) return ''
    const ext = pathname.slice(dot).toLowerCase()
    // Sanity-check: only short alphanumeric extensions.
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''
  } catch {
    return ''
  }
}

function extFromContentType(ct: string | null): string {
  if (!ct) return ''
  const mime = (ct.split(';')[0] ?? '').trim().toLowerCase()
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    case 'application/json':
      return '.json'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/wav':
      return '.wav'
    case 'video/mp4':
      return '.mp4'
    default:
      return ''
  }
}

function contentTypeFromExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.json':
      return 'application/json'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.mp4':
      return 'video/mp4'
    default:
      return 'application/octet-stream'
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
