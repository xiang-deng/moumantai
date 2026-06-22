/**
 * Enrollment window — the "closed by default" gate for device pairing.
 *
 * Unknown devices are only *recorded* as pending (so the operator can see their
 * code and approve them) while an enrollment window is open. When closed, an
 * unknown device is rejected and forgotten — no DB row — which keeps the
 * devices table clean and removes a flood/DDoS write-amplifier.
 *
 * The window is a single ISO-8601 expiry timestamp in `<home>/pairing-window`.
 * The CLI (`task server:cli -- device pair`) writes it; the server reads it on each
 * unknown handshake. Cross-process state via the filesystem — same
 * "shared store, no IPC" pattern as the pairing flag itself.
 */

import fs from 'node:fs'
import path from 'node:path'

function windowFile(home: string): string {
  return path.join(home, 'pairing-window')
}

/** Open the window for `minutes`. Returns the expiry instant. */
export function openPairingWindow(home: string, minutes: number): Date {
  const until = new Date(Date.now() + minutes * 60_000)
  fs.writeFileSync(windowFile(home), until.toISOString())
  cache = null // invalidate hot-path cache (matters when CLI + server share a process, e.g. tests)
  return until
}

/** Close the window now (idempotent). */
export function closePairingWindow(home: string): void {
  try {
    fs.unlinkSync(windowFile(home))
  } catch {
    /* already closed */
  }
  cache = null
}

/** Expiry if a window is currently open, else null (absent or already past). */
export function pairingWindowExpiry(home: string): Date | null {
  let raw: string
  try {
    raw = fs.readFileSync(windowFile(home), 'utf8').trim()
  } catch {
    return null
  }
  const d = new Date(raw)
  if (isNaN(d.getTime()) || d.getTime() <= Date.now()) return null
  return d
}

/** True while a window is open. Uncached — use the cached form on the hot path. */
export function isPairingWindowOpen(home: string): boolean {
  return pairingWindowExpiry(home) !== null
}

// Server hot-path cache: the resolver checks this on every unknown handshake,
// so under a connection flood we avoid a filesystem stat per attempt. A 1s TTL
// is well under the multi-minute window granularity.
let cache: { home: string; atMs: number; open: boolean } | null = null

/** Cached (1s TTL) window check for the server's per-handshake hot path. */
export function isPairingWindowOpenCached(home: string): boolean {
  const nowMs = Date.now()
  if (cache && cache.home === home && nowMs - cache.atMs < 1000) return cache.open
  const open = isPairingWindowOpen(home)
  cache = { home, atMs: nowMs, open }
  return open
}
