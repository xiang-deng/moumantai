/**
 * Shadow-DB lifecycle for drafts.
 *
 * Every draft gets its own SQLite DB at `<draft>/.shadow/db.sqlite`. For EDIT
 * drafts the shadow starts as a consistent clone of the live DB; for NEW-APP
 * drafts it starts empty (created on first boot).
 *
 * Clone strategy: the live DB runs in WAL mode, so a raw `fs.cp` would miss
 * uncommitted WAL pages. `VACUUM INTO` writes a fully-consistent single-file
 * snapshot of committed state. Discard needs no special handling — the shadow
 * lives inside the draft worktree, so `removeDraftWorktree` takes it with it.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'

/**
 * Clone the live app's DB into the draft's shadow path as a consistent
 * single-file snapshot via `VACUUM INTO` (includes WAL pages; refuses to
 * overwrite, so an existing shadow file is removed first).
 */
export function cloneLiveDbToShadow(liveDbPath: string, shadowDbPath: string): void {
  fs.mkdirSync(path.dirname(shadowDbPath), { recursive: true })
  if (fs.existsSync(shadowDbPath)) fs.rmSync(shadowDbPath)
  // Open non-readonly: some SQLite builds need a writable handle to acquire
  // the lock for VACUUM INTO even though it only reads the source. A second
  // connection alongside AppEngine's WAL handle is safe.
  const src = new Database(liveDbPath)
  try {
    // Escape single quotes in the destination path for the SQL string literal.
    const dest = shadowDbPath.replace(/'/g, "''")
    src.exec(`VACUUM INTO '${dest}'`)
  } finally {
    src.close()
  }
}

/**
 * Ensure the shadow directory exists for a NEW-APP draft. The `db.sqlite`
 * file is created lazily by `bootApp` on first open.
 */
export function createEmptyShadow(shadowDir: string): void {
  fs.mkdirSync(shadowDir, { recursive: true })
}

/**
 * Apply a draft's Drizzle migrations to its shadow DB. Idempotent — only
 * new migrations are applied. Used by `generate_migration` and on draft (re)boot.
 */
export function applyMigrations(shadowDbPath: string, migrationsFolder: string): void {
  const db = drizzle({ connection: shadowDbPath, casing: 'snake_case' })
  try {
    migrate(db, { migrationsFolder })
  } finally {
    // drizzle-orm/better-sqlite3 exposes the underlying driver via `$client`.
    ;(db as unknown as { $client: Database.Database }).$client.close()
  }
}

/**
 * Count user-data rows across a DB, excluding framework/cache tables
 * (`cache_*`, `__drizzle_*`, `sqlite_*`). Drives the Promote dialog warning
 * ("N rows entered during preview will be discarded").
 */
export function countDataRows(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'cache_%'
           AND name NOT LIKE '\\_\\_drizzle\\_%' ESCAPE '\\'
           AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
    let total = 0
    for (const { name } of tables) {
      // Quote via double-quotes to guard against odd identifiers.
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as {
        n: number
      }
      total += row.n
    }
    return total
  } finally {
    db.close()
  }
}
