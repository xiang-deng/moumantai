import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppEngine, getToolSchemas } from '../../../src/server/agent/app-engine.js'
import { TurnQueue } from '../../../src/server/agent/turn-queue.js'
import { createTestAppDef, notes } from '../../fixtures/test-app/index.js'
import type { AppDefinition } from '../../../src/server/agent/types.js'
import type { ConversationStore } from '../../../src/server/conversations/store.js'

function makeMinimalApp(id: string): AppDefinition {
  return {
    manifest: { id, name: id, icon: 'test', description: `App ${id}` },
    tools: [],
    faces: [],
  }
}

describe('AppEngine', () => {
  describe('boot', () => {
    it('throws for unregistered app', async () => {
      const engine = new AppEngine()
      await expect(engine.boot('nonexistent')).rejects.toThrow('no definition')
    })

    it('boots an app with schema, tools, faces, and an empty DB', async () => {
      const engine = new AppEngine()
      engine.register(createTestAppDef())
      await engine.boot('test-app')

      const app = engine.getApp('test-app')!
      expect(app.toolRegistry.size).toBe(1)
      expect(app.faceRegistry.size).toBe(2)
      expect(getToolSchemas(app).map((s) => s.name)).toEqual(['add_note'])
      // Wire-shape sanity: schemas are stripped of `execute` before they hit
      // the LLM, and every entry has the required name + description fields.
      for (const schema of getToolSchemas(app)) {
        expect('execute' in schema).toBe(false)
        expect(schema.name).toBeTruthy()
        expect(schema.description).toBeTruthy()
      }
      // Migration ran: tables exist and are empty.
      expect(app.db.select().from(notes).all()).toHaveLength(0)
    })

    it('loads + Zod-validates BootedApp.context from app definition + defaults', async () => {
      const { z } = await import('zod')
      const engine = new AppEngine()
      engine.register({
        manifest: { id: 'with-context', name: 'WC', icon: 'x', description: 'has context' },
        tools: [],
        faces: [],
        // Context schema with defaulted fields — boot resolves defaults even
        // when no context.json exists on disk yet.
        context: z.object({
          theme: z.enum(['light', 'dark']).default('light'),
          density: z.number().int().default(2),
        }),
      })
      await engine.boot('with-context')
      expect(engine.getApp('with-context')!.context).toEqual({ theme: 'light', density: 2 })
    })
  })

  describe('bootAll', () => {
    it('boots all registered apps', async () => {
      const engine = new AppEngine()
      engine.register(makeMinimalApp('a'))
      engine.register(makeMinimalApp('b'))
      const { booted, failed } = await engine.bootAll()

      expect(booted).toEqual(['a', 'b'])
      expect(failed).toHaveLength(0)
      expect(engine.getApp('a')!.manifest.id).toBe('a')
      expect(engine.getApp('b')!.manifest.id).toBe('b')
    })

    it('isolates per-app boot failures', async () => {
      const engine = new AppEngine()
      engine.register(makeMinimalApp('good'))
      // Register an app with a bad migrationsFolder that will fail during boot
      engine.register({
        manifest: { id: 'broken', name: 'Broken', icon: 'x', description: 'Will fail' },
        tools: [],
        faces: [],
        migrationsFolder: '/nonexistent/path/drizzle',
      })
      engine.register(makeMinimalApp('also-good'))

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { booted, failed } = await engine.bootAll()
      errorSpy.mockRestore()

      expect(booted).toContain('good')
      expect(booted).toContain('also-good')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.id).toBe('broken')
      expect(engine.getApp('good')).toBeDefined()
      expect(engine.getApp('also-good')).toBeDefined()
    })
  })

  describe('unregister', () => {
    it('removes a registered + booted app and returns false for an unknown id', async () => {
      const engine = new AppEngine()
      engine.register(makeMinimalApp('a'))
      await engine.boot('a')
      expect(engine.unregister('a')).toBe(true)
      expect(engine.getApp('a')).toBeUndefined()
      expect(engine.listApps()).toHaveLength(0)
      expect(engine.unregister('nope')).toBe(false)
    })
  })

  describe('swapApp', () => {
    it('replaces an app definition and reboots with fresh tools', async () => {
      const engine = new AppEngine()
      engine.register({
        manifest: { id: 'x', name: 'X', icon: 'x', description: 'v1' },
        tools: [
          {
            name: 'old_tool',
            description: 'old',
            parameters: {},
            execute: async () => ({ result: 'old' }),
          },
        ],
        faces: [],
      })
      await engine.boot('x')
      expect(engine.getApp('x')!.toolRegistry.has('old_tool')).toBe(true)

      await engine.swapApp({
        manifest: { id: 'x', name: 'X', icon: 'x', description: 'v2' },
        tools: [
          {
            name: 'new_tool',
            description: 'new',
            parameters: {},
            execute: async () => ({ result: 'new' }),
          },
        ],
        faces: [],
      })

      const app = engine.getApp('x')!
      expect(app.toolRegistry.has('new_tool')).toBe(true)
      expect(app.toolRegistry.has('old_tool')).toBe(false)
      expect(app.manifest.description).toBe('v2')
    })

    it('preserves database across swap', async () => {
      const engine = new AppEngine()
      const def = createTestAppDef()
      engine.register(def)
      await engine.boot('test-app')

      const app1 = engine.getApp('test-app')!
      app1.db.insert(notes).values({ content: 'test', category: 'work' }).run()

      await engine.swapApp(def)
      const app2 = engine.getApp('test-app')!
      const rows = app2.db.select().from(notes).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toBe('test')
    })
  })

  describe('dynamic tool mutation on a booted app', () => {
    it('addTool / removeTool mutate the live tool registry (used by wireSynthFaceTools)', async () => {
      const engine = new AppEngine()
      engine.register(makeMinimalApp('a'))
      await engine.boot('a')
      const app = engine.getApp('a')!

      // Tool: add then remove.
      engine.addTool('a', {
        name: 'dyn',
        description: 'dynamic',
        parameters: {},
        execute: async () => ({ result: 'ok' }),
      })
      expect(app.toolRegistry.has('dyn')).toBe(true)
      expect(getToolSchemas(app).find((s) => s.name === 'dyn')).toBeDefined()

      expect(engine.removeTool('a', 'dyn')).toBe(true)
      expect(app.toolRegistry.has('dyn')).toBe(false)
      expect(getToolSchemas(app).find((s) => s.name === 'dyn')).toBeUndefined()
    })
  })

  describe('getApp + shutdown', () => {
    it('getApp returns undefined for unbooted apps; shutdown clears every booted app', async () => {
      const engine = new AppEngine()
      engine.register(makeMinimalApp('a'))
      expect(engine.getApp('a')).toBeUndefined() // registered but not booted

      await engine.bootAll()
      expect(engine.getApp('a')).toBeDefined()

      engine.shutdown()
      expect(engine.getApp('a')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Lifecycle: lazy boot, idle eviction, LRU cap, file-backed persistence
  // -------------------------------------------------------------------------

  describe('lifecycle (lazy boot + eviction)', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-engine-test-'))
    })

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    })

    /**
     * Minimal stub matching the shape AppEngine consumes from ConversationStore.
     * We don't need the full store here — just `activeConversationIdsForApp`.
     */
    function makeStoreStub(mapping: Record<string, string[]> = {}): ConversationStore {
      return {
        activeConversationIdsForApp: (appId: string) => mapping[appId] ?? [],
      } as unknown as ConversationStore
    }

    it('use(appId) on a DORMANT app boots it and sets lastUsedAt', async () => {
      const engine = new AppEngine({ home: tmpDir })
      engine.register(makeMinimalApp('a'))

      // Before use: DORMANT — getApp returns undefined.
      expect(engine.getApp('a')).toBeUndefined()

      const before = Date.now()
      const app = await engine.use('a')
      const after = Date.now()

      expect(app.manifest.id).toBe('a')
      expect(app.state).toBe('active')
      expect(app.lastUsedAt).toBeGreaterThanOrEqual(before)
      expect(app.lastUsedAt).toBeLessThanOrEqual(after)
      expect(engine.getApp('a')).toBeDefined()
    })

    it('use(appId) on an ACTIVE app bumps lastUsedAt without rebooting', async () => {
      const engine = new AppEngine({ home: tmpDir })
      engine.register(makeMinimalApp('a'))
      const first = await engine.use('a')
      const firstLastUsed = first.lastUsedAt

      // Back-date so the bump is observable even on fast machines.
      first.lastUsedAt = firstLastUsed - 1000

      const second = await engine.use('a')
      expect(second).toBe(first) // same BootedApp instance
      expect(second.lastUsedAt).toBeGreaterThan(firstLastUsed - 1000)
    })

    it('idle sweep evicts an app after timeout when queue is empty', async () => {
      const store = makeStoreStub({ a: ['conv-a'] })
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        idleTimeoutMs: 100,
      })
      engine.register(makeMinimalApp('a'))
      await engine.use('a')
      expect(engine.getApp('a')).toBeDefined()

      // Pretend a lot of time has passed since the app was last touched.
      const bootedAt = engine.getApp('a')!.lastUsedAt
      await engine.sweepIdle(bootedAt + 1_000_000)

      expect(engine.getApp('a')).toBeUndefined()
    })

    it('idle sweep does NOT evict while turnQueue.hasPending(convId) is true', async () => {
      const store = makeStoreStub({ a: ['conv-a'] })
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        idleTimeoutMs: 100,
      })
      engine.register(makeMinimalApp('a'))
      await engine.use('a')

      // Start an in-flight turn that won't resolve until we let it.
      let release: () => void = () => {}
      const held = new Promise<void>((r) => {
        release = r
      })
      const turn = turnQueue.enqueue('conv-a', {
        run: async () => {
          await held
          return 42
        },
      })

      expect(turnQueue.hasPending('conv-a')).toBe(true)

      const bootedAt = engine.getApp('a')!.lastUsedAt
      await engine.sweepIdle(bootedAt + 1_000_000)

      // App is still ACTIVE — sweep saw the pending turn and skipped it.
      expect(engine.getApp('a')).toBeDefined()

      // Clean up the in-flight turn.
      release()
      await turn
    })

    it('home (in eagerBootList) is never idle-evicted', async () => {
      const store = makeStoreStub({})
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        idleTimeoutMs: 1,
      })
      engine.register(makeMinimalApp('home'))
      engine.register(makeMinimalApp('other'))
      await engine.use('home')
      await engine.use('other')

      const bootedAt = engine.getApp('home')!.lastUsedAt
      await engine.sweepIdle(bootedAt + 1_000_000)

      // `other` evicted, `home` preserved.
      expect(engine.getApp('home')).toBeDefined()
      expect(engine.getApp('other')).toBeUndefined()
    })

    it('cap-breach on boot evicts LRU (oldest lastUsedAt wins)', async () => {
      const store = makeStoreStub({})
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        maxActiveApps: 2,
      })
      engine.register(makeMinimalApp('a'))
      engine.register(makeMinimalApp('b'))
      engine.register(makeMinimalApp('c'))

      await engine.use('a')
      // Make `a` clearly older than `b`.
      engine.getApp('a')!.lastUsedAt -= 10_000
      await engine.use('b')

      // Booting `c` must evict `a` (the LRU).
      await engine.use('c')

      expect(engine.getApp('a')).toBeUndefined()
      expect(engine.getApp('b')).toBeDefined()
      expect(engine.getApp('c')).toBeDefined()
    })

    it('cap-breach times out at 500ms and proceeds even if drain never finishes', async () => {
      const store = makeStoreStub({ a: ['conv-a'] })
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        maxActiveApps: 1,
      })
      engine.register(makeMinimalApp('a'))
      engine.register(makeMinimalApp('b'))

      await engine.use('a')

      // Start a never-resolving turn on a's conversation so drain() hangs.
      let release: () => void = () => {}
      const held = new Promise<void>((r) => {
        release = r
      })
      const turn = turnQueue.enqueue('conv-a', {
        run: async () => {
          await held
          return 1
        },
      })

      const start = Date.now()
      await engine.use('b')
      const elapsed = Date.now() - start

      // Should have timed out near 500ms (allow generous tolerance for CI).
      expect(elapsed).toBeGreaterThanOrEqual(450)
      expect(elapsed).toBeLessThan(2000)
      expect(engine.getApp('b')).toBeDefined()
      expect(engine.getApp('a')).toBeUndefined()

      // Clean up.
      release()
      await turn.catch(() => {
        /* turn may resolve cleanly */
      })
    })

    it('shutdown() emits app_evict with reason: shutdown for each active app', async () => {
      const engine = new AppEngine({ home: tmpDir })
      engine.register(makeMinimalApp('a'))
      engine.register(makeMinimalApp('b'))
      await engine.use('a')
      await engine.use('b')

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      engine.shutdown()
      const calls = logSpy.mock.calls.map((c) => String(c[0]))
      logSpy.mockRestore()

      const events = calls
        .map((s) => {
          try {
            return JSON.parse(s)
          } catch {
            return null
          }
        })
        .filter(
          (e): e is { event: string; appId: string; reason: string } =>
            e !== null && e.event === 'app_evict',
        )

      expect(events).toHaveLength(2)
      expect(events.every((e) => e.reason === 'shutdown')).toBe(true)
      const ids = events.map((e) => e.appId).sort()
      expect(ids).toEqual(['a', 'b'])
      expect(engine.getApp('a')).toBeUndefined()
      expect(engine.getApp('b')).toBeUndefined()
    })

    it('file-backed DB survives eviction: register → boot → insert → evict → re-boot → row still there', async () => {
      const store = makeStoreStub({})
      const turnQueue = new TurnQueue()
      const engine = new AppEngine({
        home: tmpDir,
        store,
        turnQueue,
        idleTimeoutMs: 100,
      })
      engine.register(createTestAppDef())
      await engine.use('test-app')

      const app1 = engine.getApp('test-app')!
      app1.db.insert(notes).values({ content: 'persisted', category: 'work' }).run()

      // Force idle eviction.
      const bootedAt = app1.lastUsedAt
      await engine.sweepIdle(bootedAt + 1_000_000)
      expect(engine.getApp('test-app')).toBeUndefined()

      // Confirm the DB file exists on disk (file-backed, not :memory:).
      const dbFile = path.join(tmpDir, 'apps', 'test-app', 'db.sqlite')
      expect(fs.existsSync(dbFile)).toBe(true)

      // Re-boot and read the row back.
      await engine.use('test-app')
      const app2 = engine.getApp('test-app')!
      const rows = app2.db.select().from(notes).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toBe('persisted')
    })
  })
})
