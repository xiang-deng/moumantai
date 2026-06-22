/** Integration: fresh boot creates the canonical layout; per-app DB + cwd land at expected paths. */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { homeLayout, appPaths } from '../../src/server/workspace/home.js'

async function stop(c: ServerComponents): Promise<void> {
  c.appEngine.shutdown()
  await c.wsServer.close()
  await c.adapter.disconnect()
  // httpServer.close() throws "Server is not running" if listen() was never called.
  try {
    await new Promise<void>((resolve, reject) => {
      c.httpServer.close((err) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    if (!String(err).includes('not running')) throw err
  }
  // Release the file handle so Windows can rmSync the tempdir.
  ;(c.platformDb as unknown as { $client?: { close?: () => void } }).$client?.close?.()
}

describe('workspace boot — fresh home', () => {
  it('creates the canonical layout (config.json, platform.db, apps/home/cwd, apps-src)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-ws-'))
    try {
      const components = await createAppServer({
        adapterOverride: await connectMockAdapter(),
        port: 0,
        home,
      })
      try {
        const layout = homeLayout(home)
        expect(fs.existsSync(layout.configFile)).toBe(true)
        expect(fs.existsSync(layout.platformDb)).toBe(true)
        expect(fs.statSync(layout.homeAppCwd).isDirectory()).toBe(true)
        expect(fs.statSync(layout.appsSrcDir).isDirectory()).toBe(true)

        const cfg = JSON.parse(fs.readFileSync(layout.configFile, 'utf8'))
        expect(cfg.port).toBe(3000)
        expect(cfg.backend).toBe('claude')
      } finally {
        await stop(components)
      }
    } finally {
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* Windows handle lag */
      }
    }
  }, 15_000)

  it('loads <home>/.env into process.env', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-ws-env-'))
    try {
      // Pre-create .env BEFORE boot so the loader picks it up
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, '.env'), 'WS_TEST_FROM_ENV_FILE=loaded\n')

      delete process.env.WS_TEST_FROM_ENV_FILE // clear any stale value

      const components = await createAppServer({
        adapterOverride: await connectMockAdapter(),
        port: 0,
        home,
      })
      try {
        expect(process.env.WS_TEST_FROM_ENV_FILE).toBe('loaded')
      } finally {
        await stop(components)
        delete process.env.WS_TEST_FROM_ENV_FILE
      }
    } finally {
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* Windows handle lag */
      }
    }
  }, 15_000)
})

describe('workspace boot — running a turn lands in new layout', () => {
  it('per-app DB + synthetic cwd materialize at <home>/apps/<id>/{db.sqlite,cwd/}', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-ws-turn-'))
    try {
      const components = await createAppServer({
        adapterOverride: await connectMockAdapter(),
        port: 0,
        home,
      })
      try {
        const app = await components.appEngine.use('spend-tracker')
        expect(app).toBeDefined()

        const ap = appPaths(home, 'spend-tracker')
        expect(fs.existsSync(ap.dbFile)).toBe(true)

        // home cwd created at boot; spend-tracker's cwd is created lazily on first turn.
        const homeCwd = homeLayout(home).homeAppCwd
        expect(fs.statSync(homeCwd).isDirectory()).toBe(true)
      } finally {
        await stop(components)
      }
    } finally {
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* Windows handle lag */
      }
    }
  }, 15_000)
})
