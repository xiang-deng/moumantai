/**
 * Integration: persistence scenarios 1–6:
 *   1. 5 turns survive server restart; chatWindow restored on reconnect.
 *   2. Two tabs on the same scope receive the same chat frame (seq + convId).
 *   3. Scope switch isolates broadcasts — B on home doesn't see spend-tracker.
 *   4. Mid-turn reset aborts the running turn; fresh chatWindow with new convId.
 *   5. 25-app LRU cap (maxActiveApps=20).
 *   6. Per-app DB persists across restart.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import { create } from '@bufbuild/protobuf'
import {
  ChatRole,
  ClientMessageSchema,
  type ChatMessage,
  type ChatWindowMsg,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'

import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { openPlatformDb } from '../../src/server/db/platform-db.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { AppEngine } from '../../src/server/agent/app-engine.js'
import { TurnQueue } from '../../src/server/agent/turn-queue.js'
import type { AppDefinition } from '../../src/server/agent/types.js'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { handshake, encode } from '../helpers/raw-ws.js'
import { notes } from '../fixtures/test-app/schema.js'

async function waitFor<T>(
  fn: () => T | false | undefined | null,
  timeoutMs = 5000,
  label = '',
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? ' [' + label + ']' : ''}`)
}

function chatsIn(received: ServerMessage[]): ChatMessage[] {
  return received.flatMap((m) => (m.payload.case === 'chat' ? [m.payload.value] : []))
}

function chatWindowsIn(received: ServerMessage[]): ChatWindowMsg[] {
  return received.flatMap((m) => (m.payload.case === 'chatWindow' ? [m.payload.value] : []))
}

async function startServer(
  home: string,
  overrides: Partial<Parameters<typeof createAppServer>[0]> = {},
): Promise<{ components: ServerComponents; port: number }> {
  const components = await createAppServer({
    adapterOverride: await connectMockAdapter(),
    port: 0,
    home,
    appDirs: ['tests/fixtures'],
    ...overrides,
  })
  const httpServer = components.httpServer
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (httpServer.address() as AddressInfo).port
  return { components, port }
}

async function stopServer(components: ServerComponents): Promise<void> {
  components.appEngine.shutdown()
  await components.wsServer.close()
  await components.adapter.disconnect()
  await new Promise<void>((resolve, reject) => {
    components.httpServer.close((err) => (err ? reject(err) : resolve()))
  })
}

describe('persistence scenarios', () => {
  it('scenario 1: 5 turns on home survive server restart; client sees full chatWindow on reconnect', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-1-'))

    // Phase A: boot, run 5 turns, shut down.
    const first = await startServer(home)
    const phoneA = await handshake(first.port)

    const texts = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5']
    for (const t of texts) {
      const before = chatsIn(phoneA.received).filter((c) => c.role === ChatRole.ASSISTANT).length
      phoneA.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: t } },
          }),
        ),
      )
      await waitFor(
        () => {
          const asst = chatsIn(phoneA.received).filter((c) => c.role === ChatRole.ASSISTANT).length
          return asst > before
        },
        5000,
        `assistant reply to "${t}"`,
      )
    }

    const windowBefore = first.components.store.getWindow('home').entries
    expect(windowBefore.filter((e) => e.role === 'user').map((e) => e.text)).toEqual(texts)
    expect(windowBefore.filter((e) => e.role === 'assistant')).toHaveLength(5)

    const origConvId = first.components.store.getActive('home').id

    phoneA.ws.close()
    await stopServer(first.components)

    // Phase B: restart (same home) and reconnect.
    const second = await startServer(home)
    try {
      const phoneB = await handshake(second.port)
      const initialWindow = await waitFor(
        () => chatWindowsIn(phoneB.received).find((w) => w.scope === 'home') ?? false,
        5000,
        'initial chatWindow after restart',
      )

      expect(initialWindow.entries).toHaveLength(10)
      expect(
        initialWindow.entries.filter((e) => e.role === ChatRole.USER).map((e) => e.text),
      ).toEqual(texts)
      expect(initialWindow.conversationId).toBe(origConvId)

      const convAfter = second.components.store.getActive('home')
      expect(convAfter.id).toBe(origConvId)

      phoneB.ws.close()
    } finally {
      await stopServer(second.components)
    }
  }, 30_000)

  it('scenario 2: two tabs viewing home both receive the same chat frame (matching seq + conversationId)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-2-'))
    const { components, port } = await startServer(home)
    try {
      const a = await handshake(port)
      const b = await handshake(port)

      components.store.reset('home')
      a.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      b.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 150))
      a.received.length = 0
      b.received.length = 0

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'from A' } },
          }),
        ),
      )

      const checkBothChats = (buf: ServerMessage[]) => {
        const chats = chatsIn(buf)
        const u = chats.find((c) => c.role === ChatRole.USER && c.text === 'from A')
        const asst = chats.find((c) => c.role === ChatRole.ASSISTANT)
        return u && asst ? { u, asst } : false
      }
      const aFrames = await waitFor(() => checkBothChats(a.received), 5000, 'A frames')
      const bFrames = await waitFor(() => checkBothChats(b.received), 5000, 'B frames')

      expect(aFrames.u.conversationId).toBe(bFrames.u.conversationId)
      expect(aFrames.u.id).toBe(bFrames.u.id)
      expect(aFrames.asst.id).toBe(bFrames.asst.id)
      expect(aFrames.u.scope).toBe('home')
      expect(bFrames.u.scope).toBe('home')

      a.ws.close()
      b.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 20_000)

  it('scenario 3: scope switch via viewing isolates broadcast — B on home does not see app:spend-tracker chat', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-3-'))
    const { components, port } = await startServer(home)
    try {
      const a = await handshake(port)
      const b = await handshake(port)

      components.store.reset('home')
      components.store.reset('app:spend-tracker')
      a.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      b.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 150))

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'viewing', value: { scope: 'app:spend-tracker' } },
          }),
        ),
      )
      await new Promise((r) => setTimeout(r, 100))

      const aWindow = chatWindowsIn(a.received).filter((w) => w.scope === 'app:spend-tracker')
      expect(aWindow.length).toBeGreaterThanOrEqual(1)

      a.received.length = 0
      b.received.length = 0

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: {
              case: 'chatInput',
              value: { scope: 'app:spend-tracker', text: 'add $7 book' },
            },
          }),
        ),
      )

      await waitFor(
        () => {
          const chats = chatsIn(a.received).filter((c) => c.scope === 'app:spend-tracker')
          return (
            chats.some((c) => c.role === ChatRole.USER) &&
            chats.some((c) => c.role === ChatRole.ASSISTANT)
          )
        },
        5000,
        'A sees its own spend-tracker chat',
      )

      await new Promise((r) => setTimeout(r, 300))

      const bSpendFrames = chatsIn(b.received).filter((c) => c.scope === 'app:spend-tracker')
      expect(bSpendFrames).toHaveLength(0)

      a.ws.close()
      b.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 20_000)

  it('scenario 4: resetConversation mid-turn aborts the running turn and creates a fresh conversation (sdk_bound_at null)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-4-'))
    const { components, port } = await startServer(home, {
      adapterOverride: await connectMockAdapter(1000),
    })
    try {
      const a = await handshake(port)
      components.store.reset('home')
      a.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 100))
      a.received.length = 0

      const preConvId = components.store.getActive('home').id

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'hello' } },
          }),
        ),
      )
      await waitFor(
        () => chatsIn(a.received).some((c) => c.role === ChatRole.USER),
        2000,
        'user echo',
      )

      const assistantBefore = chatsIn(a.received).filter(
        (c) => c.role === ChatRole.ASSISTANT,
      ).length
      expect(assistantBefore).toBe(0)

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'resetConversation', value: { scope: 'home' } },
          }),
        ),
      )

      const freshWindow = await waitFor(
        () =>
          chatWindowsIn(a.received)
            .filter((w) => w.scope === 'home')
            .find((w) => w.conversationId !== preConvId) ?? false,
        5000,
        'fresh chatWindow',
      )

      expect(freshWindow.conversationId).not.toBe(preConvId)
      expect(freshWindow.entries).toHaveLength(0)

      const freshConv = components.store.getActive('home')
      expect(freshConv.id).toBe(freshWindow.conversationId)
      expect(freshConv.sdkBoundAt).toBeNull()

      a.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 20_000)

  it('scenario 5: maxActiveApps=20 caps active apps; 25 boots → 20 active + home, earliest evicted with reason=cap', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-5-'))
    const platformDb = openPlatformDb(home)
    const store = new ConversationStore(platformDb)
    const turnQueue = new TurnQueue()
    const engine = new AppEngine({
      home,
      store,
      turnQueue,
      maxActiveApps: 20,
    })

    const makeApp = (id: string): AppDefinition => ({
      manifest: { id, name: id, icon: 'test', description: `App ${id}` },
      tools: [],
      faces: [],
    })

    engine.register(makeApp('home'))
    for (let i = 0; i < 25; i++) engine.register(makeApp(`app-${i}`))

    await engine.use('home')

    const logCalls: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logCalls.push(String(args[0]))
    }
    try {
      for (let i = 0; i < 25; i++) {
        await engine.use(`app-${i}`)
        const app = engine.getApp(`app-${i}`)
        if (app) app.lastUsedAt = Date.now() - (25 - i)
      }
    } finally {
      console.log = origLog
    }

    let activeCount = 0
    for (let i = 0; i < 25; i++) if (engine.getApp(`app-${i}`)) activeCount++
    expect(engine.getApp('home')).toBeDefined()
    expect(activeCount).toBeLessThanOrEqual(20)
    expect(activeCount).toBeGreaterThanOrEqual(19)

    expect(engine.getApp('app-0')).toBeUndefined()
    expect(engine.getApp('app-1')).toBeUndefined()

    expect(engine.getApp('app-24')).toBeDefined()
    expect(engine.getApp('app-23')).toBeDefined()

    const evictionLogs = logCalls
      .map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      })
      .filter(
        (e): e is { event: string; reason: string; appId: string } =>
          e !== null && e.event === 'app_evict',
      )
    expect(evictionLogs.length).toBeGreaterThanOrEqual(4)
    for (const e of evictionLogs) expect(e.reason).toBe('cap')
    expect(evictionLogs.every((e) => e.appId !== 'home')).toBe(true)

    engine.shutdown()
    ;(platformDb as unknown as { $client?: { close?: () => void } }).$client?.close?.()
  }, 30_000)

  it('scenario 6: per-app data persists across platform restart — test-app row survives close+reopen', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-persist-6-'))

    const first = await startServer(home)
    try {
      const app = await first.components.appEngine.use('test-app')
      app.db
        .insert(notes)
        .values({
          content: 'pizza order',
          category: 'food',
        })
        .run()
    } finally {
      await stopServer(first.components)
    }

    const appDbFile = path.join(home, 'apps', 'test-app', 'db.sqlite')
    expect(fs.existsSync(appDbFile)).toBe(true)

    const second = await startServer(home)
    try {
      const app = await second.components.appEngine.use('test-app')
      const rows = app.db.select().from(notes).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toBe('pizza order')
      expect(rows[0]!.category).toBe('food')
    } finally {
      await stopServer(second.components)
    }
  }, 30_000)
})

describe('per-app DB file-backed persistence (direct drizzle)', () => {
  it('opens <home>/apps/<id>.db, writes, closes, reopens, reads — row present', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-perapp-'))
    const appsDir = path.join(home, 'apps')
    fs.mkdirSync(appsDir, { recursive: true })
    const dbPath = path.join(appsDir, 'xyz.db')

    const notes = sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      text: text('text').notNull(),
    })

    const create2 = drizzle({ connection: dbPath })
    create2.$client.exec(
      `CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`,
    )
    create2.insert(notes).values({ text: 'persisted' }).run()
    create2.$client.close()

    const reopen = drizzle({ connection: dbPath })
    const rows = reopen.select().from(notes).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('persisted')
    reopen.$client.close()

    void migrate
  })
})
