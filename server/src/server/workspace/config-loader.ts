/**
 * Config loader: <home>/config.json + <home>/.env + MOUMANTAI_* env overrides.
 *
 * The on-disk config.json is *nested* (cleaner for hand editing); the runtime
 * `ServerConfig` is flat. The loader is the only translator between the two.
 *
 * Resolution precedence (highest → lowest):
 *   1. `MOUMANTAI_*` environment variables                       (ad-hoc override)
 *   2. <home>/config.json values                              (persistent)
 *   3. Schema defaults                                        (always)
 *
 * Secrets (API keys, OAuth tokens) live in <home>/.env and are loaded into
 * process.env before this module runs — they NEVER appear in config.json.
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// On-disk schema (config.json) — nested for ergonomics
// ---------------------------------------------------------------------------

// Zod v4: `.prefault({})` runs the inner schema (applying field defaults) when
// the parent omits the key. `.default({})` substitutes the literal without re-parsing.
const VoiceSchema = z
  .object({
    sttModel: z.string().default('gpt-4o-mini-transcribe'),
    ttsModel: z.string().default('gpt-4o-mini-tts'),
    ttsVoice: z.string().default('alloy'),
  })
  .prefault({})

const AppEngineSchema = z
  .object({
    idleMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    maxActive: z.number().int().positive().default(20),
    hotReload: z.boolean().default(true),
    hotReloadDebounceMs: z.number().int().nonnegative().default(300),
  })
  .prefault({})

// Pi backend tunables. Only consulted when `backend: 'pi'`. All fields are
// optional at the schema layer; PiAgentAdapter.connect() throws if provider
// or model are missing at boot time, so you fail loud rather than silent.
const PiSchema = z
  .object({
    /** Pi provider id ('anthropic' | 'openai' | 'google' | …). */
    provider: z.string().optional(),
    /** Model id within the provider catalog (e.g. 'claude-opus-4-5'). */
    model: z.string().optional(),
    /** Pi reasoning-effort knob. Pass-through to providers that honor it. */
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  })
  .prefault({})

/**
 * A configured app registry. `name` is a local short-name (must be unique
 * across the array); `url` is a git URL or a local directory containing
 * `registry.json`.
 */
const RegistryConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
})

/**
 * Retention windows for the platform-DB maintenance loop.
 * `archivedConversationsDays`: how long `/reset`-archived conversations stay
 * queryable before they and their messages are purged. Default 90 days;
 * `-1` disables purging.
 */
const RetentionSchema = z
  .object({
    // Accept either a positive day count or the literal `-1` sentinel.
    // Anything else (0, 0.5, -2) fails validation up-front.
    archivedConversationsDays: z.union([z.number().int().min(1), z.literal(-1)]).default(90),
  })
  .prefault({})

export const ConfigFileSchema = z.object({
  $schema: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(3000),
  backend: z.enum(['claude', 'pi']).default('claude'),
  devMode: z.boolean().default(false),
  /**
   * Device pairing gate. When true (default), only allowlisted (paired) devices
   * may connect; unknown devices are rejected at the handshake and recorded as
   * pending for `task server:cli -- device approve`. Set false to disable the gate
   * (e.g. local dev) — devices still get recorded but are never blocked.
   * Takes effect on server (re)start. Env: `MOUMANTAI_PAIRING_REQUIRED`.
   */
  pairingRequired: z.boolean().default(true),
  voice: VoiceSchema,
  appEngine: AppEngineSchema,
  retention: RetentionSchema,
  pi: PiSchema,
  /** Configured app registries (`task server:cli -- registry add`). */
  appRegistries: z.array(RegistryConfigSchema).default([]),
})

export type ConfigFile = z.infer<typeof ConfigFileSchema>

// ---------------------------------------------------------------------------
// Runtime shape (flat) — what the rest of the server consumes
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Absolute path to the Moumantai home (workspace root). */
  home: string

  port: number
  backend: 'claude' | 'pi'

  // Secrets (from <home>/.env or process.env — never config.json)
  anthropicApiKey?: string
  openaiApiKey?: string

  // Pi backend (from config.pi.* + MOUMANTAI_PI_* env). Only required when
  // backend === 'pi'; otherwise undefined.
  piProvider?: string
  piModel?: string
  piThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

  // Voice (from config.voice.*)
  sttModel?: string
  ttsModel?: string
  ttsVoice?: string

  /** Dev mode gate — enables developer-facing features on all connected clients. */
  devModeEnabled: boolean

  /**
   * Device pairing gate. When true, only paired (allowlisted) devices may open
   * a session; unknown devices are rejected with `CLOSE_CODE_PAIRING_REQUIRED`
   * and recorded as pending. False disables the gate. Effective at boot.
   */
  pairingRequired: boolean

  // App engine (from config.appEngine.*)
  hotReload: boolean
  hotReloadDebounceMs: number
  appIdleMs: number
  maxActiveApps: number

  /**
   * App-source directories. Defaults to [<home>/apps-src].
   * `MOUMANTAI_APP_DIRS` overrides for tests + dev.
   */
  appDirs: string[]

  /** Configured app registries. Empty by default. */
  appRegistries: { name: string; url: string }[]

  /**
   * Retention: how many days an /reset-archived conversation lives
   * before the maintenance loop drops it. Negative = never purge.
   */
  archivedConversationsDays: number
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Load `<home>/config.json`, write defaults if missing, validate.
 * Returns the parsed (defaults-applied) ConfigFile object.
 */
export function loadConfigFile(configPath: string): ConfigFile {
  let raw: unknown
  try {
    const text = fs.readFileSync(configPath, 'utf8')
    raw = JSON.parse(text)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // First-run: write defaults so the user has a real file to inspect/edit.
      const defaults = ConfigFileSchema.parse({})
      writeConfigFile(configPath, defaults)
      return defaults
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${err.message}`)
    }
    throw err
  }

  const result = ConfigFileSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid config at ${configPath}:\n${issues}`)
  }
  return result.data
}

/**
 * Write `config.json` atomically. Used by first-run default-write, the wizard,
 * and `config edit` after a successful re-validate.
 */
export function writeConfigFile(configPath: string, config: ConfigFile): void {
  const tmp = `${configPath}.tmp`
  // Pretty-print with 2-space indent so users can hand-edit.
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n')
  fs.renameSync(tmp, configPath)
}

// ---------------------------------------------------------------------------
// Env override + flatten
// ---------------------------------------------------------------------------

/** Source of a resolved value — used by `config show` to annotate origins. */
export type ValueOrigin = 'env' | 'file' | 'default'

export interface ResolvedField<T> {
  value: T
  origin: ValueOrigin
  envVar?: string
}

/**
 * Apply `MOUMANTAI_*` env overrides on top of `config.json`, returning the
 * runtime ServerConfig and an origin map (for `config show`).
 */
export function mergeEnvOverrides(
  home: string,
  file: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): { config: ServerConfig; origins: Record<string, ResolvedField<unknown>> } {
  const origins: Record<string, ResolvedField<unknown>> = {}

  const appDirsFromEnv = env.MOUMANTAI_APP_DIRS
    ? env.MOUMANTAI_APP_DIRS.split(',')
        .map((d) => d.trim())
        .filter(Boolean)
    : null

  const config: ServerConfig = {
    home,

    port: pickInt('port', env.MOUMANTAI_PORT, file.port, origins, 'MOUMANTAI_PORT'),
    backend: pickEnum(
      'backend',
      env.MOUMANTAI_BACKEND as 'claude' | 'pi' | undefined,
      ['claude', 'pi'],
      file.backend,
      origins,
      'MOUMANTAI_BACKEND',
    ),
    devModeEnabled: pickBool(
      'devModeEnabled',
      env.MOUMANTAI_DEV_MODE,
      file.devMode,
      origins,
      'MOUMANTAI_DEV_MODE',
    ),
    pairingRequired: pickBool(
      'pairingRequired',
      env.MOUMANTAI_PAIRING_REQUIRED,
      file.pairingRequired,
      origins,
      'MOUMANTAI_PAIRING_REQUIRED',
    ),

    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,

    ...pickPi(env, file, origins),

    sttModel: pickStr(
      'sttModel',
      env.MOUMANTAI_STT_MODEL,
      file.voice.sttModel,
      origins,
      'MOUMANTAI_STT_MODEL',
    ),
    ttsModel: pickStr(
      'ttsModel',
      env.MOUMANTAI_TTS_MODEL,
      file.voice.ttsModel,
      origins,
      'MOUMANTAI_TTS_MODEL',
    ),
    ttsVoice: pickStr(
      'ttsVoice',
      env.MOUMANTAI_TTS_VOICE,
      file.voice.ttsVoice,
      origins,
      'MOUMANTAI_TTS_VOICE',
    ),

    hotReload: pickBool(
      'hotReload',
      env.MOUMANTAI_HOT_RELOAD,
      file.appEngine.hotReload,
      origins,
      'MOUMANTAI_HOT_RELOAD',
    ),
    hotReloadDebounceMs: pickInt(
      'hotReloadDebounceMs',
      env.MOUMANTAI_HOT_RELOAD_DEBOUNCE,
      file.appEngine.hotReloadDebounceMs,
      origins,
      'MOUMANTAI_HOT_RELOAD_DEBOUNCE',
    ),
    appIdleMs: pickInt(
      'appIdleMs',
      env.MOUMANTAI_APP_IDLE_MS,
      file.appEngine.idleMs,
      origins,
      'MOUMANTAI_APP_IDLE_MS',
    ),
    maxActiveApps: pickInt(
      'maxActiveApps',
      env.MOUMANTAI_MAX_ACTIVE_APPS,
      file.appEngine.maxActive,
      origins,
      'MOUMANTAI_MAX_ACTIVE_APPS',
    ),

    appDirs: appDirsFromEnv ?? defaultAppDirs(home),

    appRegistries: file.appRegistries,

    archivedConversationsDays: pickInt(
      'archivedConversationsDays',
      env.MOUMANTAI_RETENTION_ARCHIVED_DAYS,
      file.retention.archivedConversationsDays,
      origins,
      'MOUMANTAI_RETENTION_ARCHIVED_DAYS',
    ),
  }
  origins['appDirs'] = appDirsFromEnv
    ? { value: config.appDirs, origin: 'env', envVar: 'MOUMANTAI_APP_DIRS' }
    : { value: config.appDirs, origin: 'default' }
  origins['appRegistries'] = {
    value: config.appRegistries.map((r) => `${r.name}=${r.url}`),
    origin: file.appRegistries.length > 0 ? 'file' : 'default',
  }

  if (config.anthropicApiKey)
    origins['anthropicApiKey'] = { value: '<redacted>', origin: 'env', envVar: 'ANTHROPIC_API_KEY' }
  if (config.openaiApiKey)
    origins['openaiApiKey'] = { value: '<redacted>', origin: 'env', envVar: 'OPENAI_API_KEY' }

  return { config, origins }
}

/**
 * Convenience: load file + merge env in one call. Used by main.ts on boot.
 */
export function loadServerConfig(
  home: string,
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const file = loadConfigFile(configPath)
  return mergeEnvOverrides(home, file, env).config
}

// ---------------------------------------------------------------------------
// Pickers — env > file > default
// ---------------------------------------------------------------------------

/**
 * Default app-source directories. Uses `<home>/apps-src/` when it has at
 * least one subdir (production / packaged install); otherwise falls back to
 * `<cwd>/../apps` so dev runs and test tempdirs pick up repo apps.
 * Always returns absolute paths (a later `chdir()` in tests won't break it).
 */
function defaultAppDirs(home: string): string[] {
  const appsSrc = path.join(home, 'apps-src')
  try {
    const entries = fs.readdirSync(appsSrc)
    if (
      entries.some((name) => {
        try {
          return fs.statSync(path.join(appsSrc, name)).isDirectory()
        } catch {
          return false
        }
      })
    ) {
      return [appsSrc]
    }
  } catch {
    // apps-src missing or unreadable — fall through
  }
  return [path.resolve(process.cwd(), '..', 'apps')]
}

function pickStr(
  key: string,
  envVal: string | undefined,
  fileVal: string,
  origins: Record<string, ResolvedField<unknown>>,
  envVar: string,
): string {
  if (envVal !== undefined && envVal !== '') {
    origins[key] = { value: envVal, origin: 'env', envVar }
    return envVal
  }
  origins[key] = { value: fileVal, origin: 'file' }
  return fileVal
}

function pickInt(
  key: string,
  envVal: string | undefined,
  fileVal: number,
  origins: Record<string, ResolvedField<unknown>>,
  envVar: string,
): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal)
    if (Number.isFinite(n)) {
      origins[key] = { value: n, origin: 'env', envVar }
      return n
    }
  }
  origins[key] = { value: fileVal, origin: 'file' }
  return fileVal
}

function pickBool(
  key: string,
  envVal: string | undefined,
  fileVal: boolean,
  origins: Record<string, ResolvedField<unknown>>,
  envVar: string,
): boolean {
  // Accept exactly `true` / `false` (case-insensitive) — never coerce `1` / `yes` / typos,
  // which could silently disable features.
  if (envVal !== undefined && envVal !== '') {
    const norm = envVal.toLowerCase()
    if (norm === 'true' || norm === 'false') {
      const v = norm === 'true'
      origins[key] = { value: v, origin: 'env', envVar }
      return v
    }
  }
  origins[key] = { value: fileVal, origin: 'file' }
  return fileVal
}

function pickEnum<T extends string>(
  key: string,
  envVal: T | undefined,
  allowed: readonly T[],
  fileVal: T,
  origins: Record<string, ResolvedField<unknown>>,
  envVar: string,
): T {
  if (envVal !== undefined && allowed.includes(envVal)) {
    origins[key] = { value: envVal, origin: 'env', envVar }
    return envVal
  }
  origins[key] = { value: fileVal, origin: 'file' }
  return fileVal
}

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

/**
 * Pick the three Pi fields (env > file). Strips undefined values so the
 * spread into ServerConfig leaves them absent rather than `key: undefined`.
 */
function pickPi(
  env: NodeJS.ProcessEnv,
  file: ConfigFile,
  origins: Record<string, ResolvedField<unknown>>,
): { piProvider?: string; piModel?: string; piThinkingLevel?: PiThinkingLevel } {
  const out: { piProvider?: string; piModel?: string; piThinkingLevel?: PiThinkingLevel } = {}

  const provider = env.MOUMANTAI_PI_PROVIDER ?? file.pi.provider
  if (provider) {
    out.piProvider = provider
    origins['piProvider'] = env.MOUMANTAI_PI_PROVIDER
      ? { value: provider, origin: 'env', envVar: 'MOUMANTAI_PI_PROVIDER' }
      : { value: provider, origin: 'file' }
  }

  const model = env.MOUMANTAI_PI_MODEL ?? file.pi.model
  if (model) {
    out.piModel = model
    origins['piModel'] = env.MOUMANTAI_PI_MODEL
      ? { value: model, origin: 'env', envVar: 'MOUMANTAI_PI_MODEL' }
      : { value: model, origin: 'file' }
  }

  const rawLevel = env.MOUMANTAI_PI_THINKING_LEVEL ?? file.pi.thinkingLevel
  if (rawLevel && (PI_THINKING_LEVELS as readonly string[]).includes(rawLevel)) {
    out.piThinkingLevel = rawLevel as PiThinkingLevel
    origins['piThinkingLevel'] = env.MOUMANTAI_PI_THINKING_LEVEL
      ? { value: rawLevel, origin: 'env', envVar: 'MOUMANTAI_PI_THINKING_LEVEL' }
      : { value: rawLevel, origin: 'file' }
  }

  return out
}
