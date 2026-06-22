/**
 * Server configuration entry point.
 *
 * Resolves Moumantai Home, loads `<home>/.env` and `<home>/config.json`, and
 * merges `MOUMANTAI_*` env-var overrides. Precedence: env > config.json > defaults.
 * See `workspace/config-loader.ts`. Build/dev env vars live in `.mise.local.toml`.
 */

import { resolveMoumantaiHome, ensureHomeLayout } from './workspace/home.js'
import { applyToProcessEnv, readEnvFile } from './workspace/dotenv.js'
import { loadServerConfig } from './workspace/config-loader.js'
import type { ServerConfig } from './workspace/config-loader.js'

export type { ServerConfig } from './workspace/config-loader.js'

export interface LoadConfigOptions {
  /** Override home resolution. Used by tests. */
  home?: string
  /** Override cwd used for project-local home detection. Defaults to process.cwd(). */
  cwd?: string
}

/** Bootstrap the workspace and load resolved config. Call once at server boot. */
export function loadConfig(opts: LoadConfigOptions = {}): ServerConfig {
  const cwd = opts.cwd ?? process.cwd()
  const home = opts.home ?? resolveMoumantaiHome({ cwd })

  const layout = ensureHomeLayout(home)

  applyToProcessEnv(readEnvFile(layout.envFile))

  return loadServerConfig(home, layout.configFile)
}
