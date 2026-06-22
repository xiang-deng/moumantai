/**
 * Asset URL resolution for renderer images.
 *
 * Plugin faces emit server-relative paths like `/apps/scoreboard/assets/<hash>.png`.
 * Resolves against the same backend the WebSocket transport is pointed at:
 * `ws://host:port/...` → `http://host:port/<src>`. No standalone detection —
 * a single source of truth (the configured server URL) drives both transports.
 *
 * Absolute URLs pass through unchanged.
 */
import { resolveDefaultServerUrl } from './ws-transport'

export function resolveAssetUrl(src: string | undefined): string | undefined {
  if (!src) return src
  if (!src.startsWith('/')) return src

  const wsUrl = resolveDefaultServerUrl()
  if (!wsUrl) return src
  // ws:// → http://  /  wss:// → https://. Anything else (already http/https)
  // passes through.
  const httpOrigin = wsUrl.replace(/^ws(s?):/, 'http$1:')
  return `${httpOrigin}${src}`
}
