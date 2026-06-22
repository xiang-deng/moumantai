/**
 * defineRefreshTask() helper for authoring app-level refresh tasks.
 *
 * Validates the spec shape and returns a frozen RefreshTaskDefinition. Used
 * by developer-authored refresh tasks in apps/{id}/refresh-tasks/*.ts.
 *
 * Face-bound refresh is declared inline on `defineFace`'s `refresh` field,
 * not via this builder.
 */

import type { RefreshTaskDefinition } from './types.js'

const VALID_INTERVAL = /^\d+(s|m|h)$/

/**
 * Define an app-level refresh task. Runs on a schedule, gated by `mountedOnly`,
 * with optional boot-time warmup.
 *
 * ```typescript
 * export default defineRefreshTask({
 *   id: 'refresh_today',
 *   every: '15m',
 *   mountedOnly: true,
 *   warmup: true,
 *   run: async ({ db, http, config }) => {
 *     const games = await http.fetch('https://...').then(r => r.json())
 *     await db.insert(cache_games).values(games).onConflictDoUpdate(...)
 *     return { nextRun: anyLive(games) ? '10s' : '15m' }
 *   },
 * })
 * ```
 */
export function defineRefreshTask(spec: {
  id: string
  every: string
  mountedOnly?: boolean
  warmup?: boolean
  run: RefreshTaskDefinition['run']
}): RefreshTaskDefinition {
  if (!spec.id || typeof spec.id !== 'string') {
    throw new Error('defineRefreshTask: id is required and must be a string')
  }
  if (!spec.every || typeof spec.every !== 'string') {
    throw new Error('defineRefreshTask: every is required and must be a string (e.g. "30s")')
  }
  if (!VALID_INTERVAL.test(spec.every)) {
    throw new Error(
      `defineRefreshTask: every must match /^\\d+(s|m|h)$/ (got "${spec.every}"). ` +
        `Use interval form like "5s" / "30s" / "5m" / "1h", not cron expressions.`,
    )
  }
  if (typeof spec.run !== 'function') {
    throw new Error('defineRefreshTask: run is required and must be a function')
  }

  // Default: mountedOnly=true. warmup defaults to true when mountedOnly=true
  // (fresh-on-first-open guarantee), false otherwise.
  const mountedOnly = spec.mountedOnly ?? true
  const warmup = spec.warmup ?? mountedOnly

  return Object.freeze({
    id: spec.id,
    every: spec.every,
    mountedOnly,
    warmup,
    run: spec.run,
  })
}
