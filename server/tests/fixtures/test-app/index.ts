/**
 * Synthetic AppDefinition used as a fixture for framework tests.
 * Avoids importing from the `apps/` git submodule.
 */

import type { AppDefinition } from 'moumantai'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest } from './manifest.js'
import * as schema from './schema.js'
import addNote from './tools/add-note.js'
import notesList from './faces/notes-list.js'
import notesSummary from './faces/notes-summary.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export function createTestAppDef(): AppDefinition {
  return {
    manifest,
    schema,
    migrationsFolder: resolve(__dirname, 'drizzle'),
    tools: [addNote],
    faces: [notesList, notesSummary],
  }
}

export { notes } from './schema.js'
export { notesSummary, notesList }
