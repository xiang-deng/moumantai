/**
 * Integration: `getWindow(scope, limit)` caps the visible display window against
 * the real ConversationStore constructed by `createAppServer`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'http'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'

let components: ServerComponents
let httpServer: HttpServer

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-history-cap-'))
  components = await createAppServer({ adapterOverride: await connectMockAdapter(), port: 0, home })
  httpServer = components.httpServer
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve)
  })
}, 15_000)

afterAll(async () => {
  components.appEngine.shutdown()
  await components.wsServer.close()
  await components.adapter.disconnect()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()))
  })
}, 10_000)

describe('ConversationStore window cap on the live server', () => {
  it('150 appends yields persistent rows but getWindow(scope) returns only the last 50 (default cap)', async () => {
    components.store.reset('home') // fresh seq sequence
    const conv = components.store.getActive('home')

    for (let i = 0; i < 150; i++) {
      components.store.appendTurn(conv.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `entry-${i}`,
        turnMode: 'direct_user_chat',
      })
    }

    const window = components.store.getWindow('home').entries
    expect(window).toHaveLength(50)
    expect(window[0]!.text).toBe('entry-100') // last-50 slice: entry-100..entry-149
    expect(window.at(-1)!.text).toBe('entry-149')
    for (let i = 0; i < 50; i++) {
      expect(window[i]!.text).toBe(`entry-${i + 100}`)
    }
    for (let i = 1; i < window.length; i++) {
      // seq must be monotonic
      expect(window[i]!.seq).toBe(window[i - 1]!.seq + 1)
    }
  })

  it('explicit larger limit retrieves more entries past the default', async () => {
    components.store.reset('home')
    const conv = components.store.getActive('home')
    for (let i = 0; i < 80; i++) {
      components.store.appendTurn(conv.id, {
        role: 'user',
        text: `entry-${i}`,
        turnMode: 'direct_user_chat',
      })
    }
    expect(components.store.getWindow('home').entries).toHaveLength(50)
    expect(components.store.getWindow('home', 75).entries).toHaveLength(75)
    expect(components.store.getWindow('home', 200).entries).toHaveLength(80)
  })

  it('per-scope isolation: home and app:X windows are independent', async () => {
    components.store.reset('home')
    components.store.reset('app:spend-tracker')
    const home = components.store.getActive('home')
    const app = components.store.getActive('app:spend-tracker')

    for (let i = 0; i < 120; i++) {
      components.store.appendTurn(home.id, {
        role: 'user',
        text: `home-${i}`,
        turnMode: 'direct_user_chat',
      })
    }
    for (let i = 0; i < 30; i++) {
      components.store.appendTurn(app.id, {
        role: 'user',
        text: `app-${i}`,
        turnMode: 'direct_user_chat',
      })
    }

    expect(components.store.getWindow('home').entries).toHaveLength(50)
    expect(components.store.getWindow('app:spend-tracker').entries).toHaveLength(30)
    expect(components.store.getWindow('home').entries[0]!.text).toBe('home-70')
    expect(components.store.getWindow('app:spend-tracker').entries[0]!.text).toBe('app-0')
  })
})
