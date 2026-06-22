/**
 * Pure app-boot mechanics, shared by `AppEngine.boot` and `DraftRegistry`.
 *
 * Covers what is identical for live apps (`<home>/apps/<id>/db.sqlite`) and
 * drafts (`<draft>/.shadow/db.sqlite`): open SQLite, run migrations,
 * PRAGMA-optimize, build tool/face registries, load context/config.
 *
 * Deliberately excludes lifecycle/policy work — no `afterBootHook`, no eviction
 * bookkeeping, no registry insertion, no `wireSynthFaceTools` (each caller wires
 * it after boot with its own param-store key).
 *
 * The returned `BootedApp` has `state: 'active'` and `lastUsedAt` stamped to
 * boot time; callers re-stamp on `use()` per their own policy.
 */

import fs from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type Database from 'better-sqlite3'
import type { AppDefinition, ToolDefinition } from './types.js'
import type { BootedApp } from './app-engine.js'
import { FaceRegistry } from './face-loader.js'
import { loadAppContext } from '../framework/app-context.js'
import { loadAppConfig } from '../framework/app-config.js'
import { runOptimize } from '../db/maintenance.js'

export interface BootAppOptions {
  /** The app (or draft) definition to boot. */
  appDef: AppDefinition
  /** Absolute path to the SQLite file (created if missing). */
  dbPath: string
  /** Migrations to apply. Defaults to `appDef.migrationsFolder`. Idempotent. */
  migrationsFolder?: string
  /**
   * Moumantai home + appId for loading `context.json` / `config.json` / `.env`.
   * Edit drafts pass the LIVE appId to inherit the live app's context/config
   * (read-only). New-app drafts have no file yet; both resolve to `{}`.
   */
  home: string
  appId: string
}

/**
 * Open + migrate the DB, build the tool/face registries, load context/config,
 * and return a fresh `BootedApp`. Pure mechanics — see file header for what is
 * intentionally excluded.
 */
export function bootApp({
  appDef,
  dbPath,
  migrationsFolder,
  home,
  appId,
}: BootAppOptions): BootedApp {
  // 1. Open (or create) the file-backed SQLite DB.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = drizzle({ connection: dbPath, casing: 'snake_case' })

  // If anything throws after open (bad migration, invalid face graph, malformed
  // context.json), close the handle — the caller never receives a BootedApp to
  // close. Especially relevant for drafts, whose migrations are agent-authored.
  try {
    // 2. Run migrations (idempotent).
    const folder = migrationsFolder ?? appDef.migrationsFolder
    if (folder) {
      migrate(db, { migrationsFolder: folder })
    }

    // SQLite-recommended PRAGMA optimize per open — see `db/maintenance.ts`.
    runOptimize(db)

    // 3. Register tools.
    const toolRegistry = new Map<string, ToolDefinition>()
    for (const tool of appDef.tools) {
      toolRegistry.set(tool.name, tool)
    }

    // 4. Register faces (validates component graph; bad refs / missing root throw here).
    const faceRegistry = new FaceRegistry()
    for (const face of appDef.faces) {
      faceRegistry.register(face, { source: `app:${appId}` })
    }

    // 5. Load LLM-visible app context (Zod-validated; `{}` when no schema/file).
    const context = loadAppContext({ home, appId, schema: appDef.context })

    // 6. Load technical config (secrets route to `.env`; `{}` when no schema).
    const config = loadAppConfig({ home, appId, schema: appDef.config })

    return {
      manifest: appDef.manifest,
      schema: appDef.schema,
      db,
      toolRegistry,
      faceRegistry,
      skill: appDef.skill,
      state: 'active',
      lastUsedAt: Date.now(),
      context,
      config,
    }
  } catch (err) {
    try {
      ;(db as unknown as { $client: Database.Database }).$client.close()
    } catch {
      /* best-effort */
    }
    throw err
  }
}
