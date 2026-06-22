#!/usr/bin/env node
/**
 * Portable per-app drizzle-kit wrapper.
 *
 * Usage (from server/):
 *   npm run db:generate -- <app-id>
 *
 * Example:
 *   npm run db:generate -- diet-tracker
 *
 * Why this exists: server/drizzle.config.ts is hardcoded to
 * spend-tracker. Rather than fight the config, we call drizzle-kit with
 * explicit --schema / --out flags per app, and set NODE_PATH so it can
 * resolve `moumantai` and `drizzle-orm` inside the app's schema.ts.
 *
 * If no app-id is passed, falls back to drizzle.config.ts (spend-tracker).
 */

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

const appId = process.argv[2]

const env = { ...process.env, NODE_PATH: './node_modules' }

let args: string[]
if (appId) {
  if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
    console.error(`error: app-id must match /^[a-z][a-z0-9-]*$/, got: "${appId}"`)
    process.exit(2)
  }
  // We are running from server/, so '..' reaches the repo root.
  const schemaPath = resolve(process.cwd(), '..', 'apps', appId, 'schema.ts')
  if (!existsSync(schemaPath)) {
    console.error(`error: ${schemaPath} not found. Did you scaffold the app?`)
    process.exit(2)
  }
  args = [
    'drizzle-kit',
    'generate',
    '--dialect',
    'sqlite',
    '--schema',
    `../apps/${appId}/schema.ts`,
    '--out',
    `../apps/${appId}/drizzle`,
  ]
  console.log(`db-generate: targeting apps/${appId}/`)
} else {
  args = ['drizzle-kit', 'generate']
  console.log('db-generate: no app-id provided, using drizzle.config.ts (spend-tracker)')
}

const result = spawnSync('npx', args, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

process.exit(result.status ?? 1)
