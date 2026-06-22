/**
 * Platform DB — chat history and SDK session bindings.
 *
 * One file per install: `<home>/platform.db`. Migrations in
 * `server/drizzle/platform/` are applied on open. Per-app data lives
 * in `<home>/apps/<appId>/db.sqlite`, managed by AppEngine.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../conversations/schema.js'
import { homeLayout } from '../workspace/home.js'
import { runOptimize } from './maintenance.js'

export type PlatformDb = BetterSQLite3Database<typeof schema>

/** Default path to the platform DB file under a given home dir. */
export function platformDbPath(home: string): string {
  return homeLayout(home).platformDb
}

/** Path to the bundled migrations folder (resolved relative to this module). */
function migrationsFolder(): string {
  // Source layout: server/src/server/db/platform-db.ts
  // Migrations:     server/drizzle/platform/
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../drizzle/platform')
}

/**
 * Open the platform DB, run migrations, and return a typed Drizzle handle.
 * Synchronous. Runs `PRAGMA optimize` after migrations (see `db/maintenance.ts`).
 */
export function openPlatformDb(home: string): PlatformDb {
  fs.mkdirSync(home, { recursive: true })
  const dbPath = platformDbPath(home)
  const db = drizzle({ connection: dbPath, schema, casing: 'snake_case' }) as PlatformDb
  migrate(db, { migrationsFolder: migrationsFolder() })
  runOptimize(db)
  return db
}
