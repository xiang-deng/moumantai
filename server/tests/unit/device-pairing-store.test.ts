/**
 * Unit: pairing code derivation + ConversationStore pairing methods.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openPlatformDb } from '../../src/server/db/platform-db.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { deviceCode } from '../../src/server/conversations/device-code.js'

describe('deviceCode', () => {
  it('is the last 4 hex of the deviceId, uppercased', () => {
    expect(deviceCode('11111111-1111-4111-8111-aaaaaaaa4f2a')).toBe('4F2A')
    expect(deviceCode('22222222-2222-4222-8222-bbbbbbbb1234')).toBe('1234')
  })
})

describe('ConversationStore pairing', () => {
  let store: ConversationStore

  beforeEach(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-pair-store-'))
    store = new ConversationStore(openPlatformDb(home))
  })

  it('records a device as pending and reads back paired=false', () => {
    store.upsertDevice({
      deviceId: 'd1',
      deviceClass: 1,
      deviceProfileWidth: 390,
      deviceProfileHeight: 844,
    })
    expect(store.isDevicePaired('d1')).toBe(false)
    expect(store.getDevice('d1')!.paired).toBe(false)
  })

  it('isDevicePaired is false for an unknown device', () => {
    expect(store.isDevicePaired('ghost')).toBe(false)
  })

  it('approve sets paired + pairedAt + optional label; revoke clears them', () => {
    store.upsertDevice({ deviceId: 'd2' })
    expect(store.setDevicePaired('d2', true, 'Kitchen')).toBe(true)
    const paired = store.getDevice('d2')!
    expect(paired.paired).toBe(true)
    expect(paired.pairedAt).toBeTruthy()
    expect(paired.deviceLabel).toBe('Kitchen')

    store.setDevicePaired('d2', false)
    const revoked = store.getDevice('d2')!
    expect(revoked.paired).toBe(false)
    expect(revoked.pairedAt).toBeNull()
    expect(revoked.deviceLabel).toBe('Kitchen') // revoke keeps the name
  })

  it('approve can pre-create a row for a never-seen deviceId; revoke of unknown returns false', () => {
    expect(store.setDevicePaired('preapproved', true)).toBe(true)
    expect(store.isDevicePaired('preapproved')).toBe(true)
    expect(store.setDevicePaired('never-existed', false)).toBe(false)
  })

  it('rename sets the label; false when the device is absent', () => {
    store.upsertDevice({ deviceId: 'd3' })
    expect(store.renameDevice('d3', 'Watch')).toBe(true)
    expect(store.getDevice('d3')!.deviceLabel).toBe('Watch')
    expect(store.renameDevice('absent', 'X')).toBe(false)
  })

  it('forget deletes the row; false when absent', () => {
    store.upsertDevice({ deviceId: 'd4' })
    expect(store.forgetDevice('d4')).toBe(true)
    expect(store.getDevice('d4')).toBeUndefined()
    expect(store.forgetDevice('d4')).toBe(false)
  })

  it('listDevices shows paired + recent pending, newest-seen first', () => {
    store.setDevicePaired('paired-dev', true)
    store.upsertDevice({ deviceId: 'pending-fresh' })

    const ids = store.listDevices().map((d) => d.deviceId)
    expect(ids).toContain('paired-dev')
    expect(ids).toContain('pending-fresh')
  })

  it('pruneDevices removes unpaired, stale, or all rows', () => {
    store.setDevicePaired('keep-paired', true)
    store.upsertDevice({ deviceId: 'drop-pending' })
    expect(store.pruneDevices({ unpaired: true })).toBe(1)
    expect(store.getDevice('drop-pending')).toBeUndefined()
    expect(store.getDevice('keep-paired')).toBeDefined()

    // No-op when no filter is given.
    expect(store.pruneDevices({})).toBe(0)

    // --all wipes everything, including paired.
    store.upsertDevice({ deviceId: 'another' })
    expect(store.pruneDevices({ all: true })).toBe(2)
    expect(store.listDevices({ includeOldPending: true })).toHaveLength(0)
  })
})
