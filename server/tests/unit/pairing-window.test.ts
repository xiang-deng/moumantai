/**
 * Unit: enrollment-window open/close/expiry.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  openPairingWindow,
  closePairingWindow,
  pairingWindowExpiry,
  isPairingWindowOpen,
  isPairingWindowOpenCached,
} from '../../src/server/workspace/pairing-window.js'

describe('pairing-window', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-window-'))
  })

  it('is closed by default', () => {
    expect(isPairingWindowOpen(home)).toBe(false)
    expect(pairingWindowExpiry(home)).toBeNull()
  })

  it('open → open, close → closed', () => {
    const until = openPairingWindow(home, 5)
    expect(until.getTime()).toBeGreaterThan(Date.now())
    expect(isPairingWindowOpen(home)).toBe(true)
    expect(pairingWindowExpiry(home)).not.toBeNull()

    closePairingWindow(home)
    expect(isPairingWindowOpen(home)).toBe(false)
  })

  it('an already-expired window reads as closed', () => {
    // Write a past timestamp directly.
    fs.writeFileSync(path.join(home, 'pairing-window'), new Date(Date.now() - 1000).toISOString())
    expect(isPairingWindowOpen(home)).toBe(false)
  })

  it('cached check reflects open/close immediately (cache invalidated on write)', () => {
    expect(isPairingWindowOpenCached(home)).toBe(false)
    openPairingWindow(home, 5)
    expect(isPairingWindowOpenCached(home)).toBe(true)
    closePairingWindow(home)
    expect(isPairingWindowOpenCached(home)).toBe(false)
  })
})
