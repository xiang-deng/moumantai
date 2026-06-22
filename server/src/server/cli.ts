/**
 * Moumantai CLI entry point.
 *
 * There is no `moumantai` binary — the package is private and run from a repo
 * checkout. Invoke via:
 *   task server:cli -- <command>           (preferred)
 *   npx tsx src/server/cli.ts <command>    (raw)
 *
 * Subcommands:
 *   init                          → run setup wizard (or silent default if --non-interactive)
 *   config [show]                 → print resolved config with origin annotations
 *   config edit                   → open $EDITOR on config.json; re-validate on save
 *   workspace path|set|reset      → inspect / point / unpoint the workspace home
 *   app install <path|url>        → install from local path or git URL (<url>#<ref>:<subdir>)
 *   app install <id> --from <url> → resolve <id> via registry at <url>, then install
 *   app update [<id>]             → re-fetch git-installed apps; no-op for local
 *   app uninstall <id>            → uninstall (asks before deleting runtime state)
 *   app list [--from <url>]       → list installed apps, or browse a registry catalog
 *
 * The setup wizard lives in `init` only; `config` is read/edit-only.
 * All interactive prompts use Node's built-in node:readline/promises (no deps).
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, stderr, exit, env, platform } from 'node:process'
import {
  resolveMoumantaiHome,
  resolveMoumantaiHomeWithSource,
  ensureHomeLayout,
  homeLayout,
  defaultPointerPath,
  writeHomePointer,
  deleteHomePointer,
  readHomePointer,
} from './workspace/home.js'
import {
  loadConfigFile,
  writeConfigFile,
  mergeEnvOverrides,
  type ResolvedField,
} from './workspace/config-loader.js'
import { applyToProcessEnv, readEnvFile } from './workspace/dotenv.js'
import {
  installApp,
  uninstallApp,
  updateApp,
  deleteAppRuntimeState,
  listInstalled,
} from './workspace/apps-installer.js'
import { fetchRegistry, resolveAppFromRegistry } from './workspace/registry.js'
import { runWizard, promptAppConfigWizard } from './workspace/wizard.js'
import { findEntryFile, loadAppModule, validateAppDef } from './agent/app-loader.js'
import { openPlatformDb } from './db/platform-db.js'
import { FaceParamsStore } from './agent/face-params-store.js'
import { ConversationStore } from './conversations/store.js'
import { deviceCode } from './conversations/device-code.js'
import {
  openPairingWindow,
  closePairingWindow,
  pairingWindowExpiry,
} from './workspace/pairing-window.js'
import type { Device } from './conversations/schema.js'
import { DeviceClass } from '@moumantai/protocol/generated/moumantai/v1'
import { getNativeClient } from './db/maintenance.js'

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv

  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        printHelp()
        return 0

      case 'init':
        return await cmdInit(rest)

      case 'config':
        return await cmdConfig(sub)

      case 'workspace':
        return await cmdWorkspace(sub, rest)

      case 'app':
        return await cmdApp(sub, rest)

      case 'registry':
        return await cmdRegistry(sub, rest)

      case 'db':
        return await cmdDb(sub, rest)

      case 'device':
        return await cmdDevice(sub, rest)

      default:
        stderr.write(`Unknown command: ${cmd}\n\n`)
        printHelp()
        return 2
    }
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function printHelp(): void {
  stdout.write(`moumantai — workspace + config management

There is no \`moumantai\` binary. Run from a repo checkout via:
  task server:cli -- <command>            (preferred)
  npx tsx src/server/cli.ts <command>     (raw)

Commands:
  init [--non-interactive]      Set up / reconfigure the workspace (interactive wizard).
  config [show]                 Print resolved config with origin annotations (bare config = show).
  config edit                   Open config.json in $EDITOR; re-validate on save.
  workspace path                Print resolved workspace path + source (env/walker/pointer/default).
  workspace set <path>          Stamp the pointer to <path> (creates the dir if missing).
  workspace reset               Delete the pointer file (revert to walker/default).
  app install <path|url>        Install from local path or git URL.
                                  Git form: <url>[#<ref>[:<subdir>]]
                                  e.g. https://github.com/x/repo#v0.2.0:apps/spend-tracker
  app install <id> --from <url> Resolve <id> via registry at <url>, then install.
  app install <id>              (No --from) Resolve <id> across configured registries.
  app update [<id>]             Re-fetch installed apps (all if no id given).
  app uninstall <id> [--force]  Uninstall a plugin app.
  app list                      List installed plugin apps.
  app list --from <url>         Browse a registry's catalog (no install).
  app search <query>            Substring search id+description across configured registries.
  app configure <id>            Interactive wizard for an app's config + context.
  app cache-clear <id> [--yes]  Wipe an app's asset cache.
  registry add <name> <url>     Add a configured registry.
  registry list                 List configured registries.
  registry remove <name>        Remove a configured registry.
  registry update [<name>]      Refresh git-cache for one or all registries.
  db purge --older-than <Nd>    Delete archived conversations + messages older than N days.
  device pair [--minutes <N>]   Open an enrollment window (default 5m) + interactively approve devices.
  device list [--all]           List devices (paired + pending); --all includes old pending probes.
  device approve <code|id> [--name <label>]  Approve (pair) a device; optionally name it.
  device revoke <code|id>       Revoke (un-pair) a device; keeps it listed as pending.
  device forget <code|id>       Delete a device entirely (it returns as pending if it reconnects).
  device rename <code|id> <name>  Set a device's display name.
  device prune [--older-than <Nd>] [--unpaired] [--all] [--yes]  Bulk-delete stale/junk device rows.

Environment:
  MOUMANTAI_HOME               Override the workspace location (default: ~/.moumantai/).
  MOUMANTAI_PAIRING_REQUIRED   true|false — gate connections on pairing (default true).
`)
}

// ---------------------------------------------------------------------------
// init / config
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<number> {
  const nonInteractive = args.includes('--non-interactive') || !stdin.isTTY
  const home = resolveMoumantaiHome()

  if (nonInteractive) {
    // Just ensure layout + a default config.json at the resolved home.
    ensureHomeLayout(home)
    const layout = homeLayout(home)
    loadConfigFile(layout.configFile)
    stdout.write(`Workspace ready at ${home} (non-interactive defaults)\n`)
    return 0
  }

  // Interactive: wizard owns the workspace path choice and calls ensureHomeLayout
  // on the final path — avoids leaving an empty ~/.moumantai/ on location change.
  await runWizard({ home, stdout, stderr, stdin })
  return 0
}

async function cmdConfig(sub: string | undefined): Promise<number> {
  switch (sub) {
    case undefined:
    case 'show':
      // Bare `config` = `config show`. The setup wizard is `init` only.
      return await cmdConfigShow()
    case 'edit':
      return await cmdConfigEdit()
    case 'path':
      // Removed: home-path inspection now lives under `workspace`.
      stderr.write(`\`config path\` was removed — use \`workspace path\` instead.\n`)
      return 2
    default:
      stderr.write(`Unknown config subcommand: ${sub}\n`)
      printHelp()
      return 2
  }
}

async function cmdConfigShow(): Promise<number> {
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const layout = homeLayout(home)
  applyToProcessEnv(readEnvFile(layout.envFile))

  const file = loadConfigFile(layout.configFile)
  const { config, origins } = mergeEnvOverrides(home, file)

  stdout.write(`Moumantai home: ${home}\n\n`)
  stdout.write(`Resolved config (env > config.json > defaults):\n`)
  for (const [key, value] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'home') continue
    const origin = origins[key]
    stdout.write(
      `  ${key.padEnd(24)} ${formatValue(origin?.value ?? value)}  ${formatOrigin(origin)}\n`,
    )
  }
  stdout.write(`\nWorkspace files:\n`)
  stdout.write(`  config.json   ${layout.configFile}\n`)
  stdout.write(
    `  .env          ${layout.envFile}${fs.existsSync(layout.envFile) ? '' : ' (not present)'}\n`,
  )
  stdout.write(
    `  platform.db   ${layout.platformDb}${fs.existsSync(layout.platformDb) ? '' : ' (not yet created)'}\n`,
  )
  return 0
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  return String(v)
}

function formatOrigin(o: ResolvedField<unknown> | undefined): string {
  if (!o) return ''
  if (o.origin === 'env') return `(env: ${o.envVar})`
  if (o.origin === 'file') return `(config.json)`
  return `(default)`
}

async function cmdConfigEdit(): Promise<number> {
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const layout = homeLayout(home)
  // Ensure file exists so the editor opens a real (defaulted) doc, not a blank.
  loadConfigFile(layout.configFile)

  const editor = pickEditor()
  const original = fs.readFileSync(layout.configFile, 'utf8')

  await runEditor(editor, layout.configFile)

  // Re-validate. If invalid, ask whether to revert.
  try {
    loadConfigFile(layout.configFile)
    stdout.write(`Saved.\n`)
    return 0
  } catch (err) {
    stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`)
    if (!stdin.isTTY) {
      // Non-interactive: refuse to commit garbage; restore.
      fs.writeFileSync(layout.configFile, original)
      stderr.write(`Reverted (non-interactive mode).\n`)
      return 1
    }
    const answer = await prompt(`Revert to last good config? [Y/n] `)
    if (answer === '' || /^y(es)?$/i.test(answer)) {
      fs.writeFileSync(layout.configFile, original)
      stderr.write(`Reverted.\n`)
    } else {
      stderr.write(`Left invalid file in place. Server will refuse to start until fixed.\n`)
    }
    return 1
  }
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

async function cmdWorkspace(sub: string | undefined, args: string[]): Promise<number> {
  switch (sub) {
    case undefined:
    case 'path':
      return cmdWorkspacePath()
    case 'set':
      return cmdWorkspaceSet(args)
    case 'reset':
      return cmdWorkspaceReset()
    default:
      stderr.write(`Unknown workspace subcommand: ${sub}\n`)
      printHelp()
      return 2
  }
}

function cmdWorkspacePath(): number {
  const { home, source } = resolveMoumantaiHomeWithSource()
  const pointerPath = defaultPointerPath()
  const pointed = readHomePointer(pointerPath)
  stdout.write(`${home}\n`)
  stdout.write(`  source:   ${source}\n`)
  stdout.write(`  pointer:  ${pointerPath}${pointed ? '' : ' (not present)'}\n`)
  if (pointed) stdout.write(`  → ${pointed}\n`)
  return 0
}

function cmdWorkspaceSet(args: string[]): number {
  const target = args[0]
  if (!target || target.startsWith('-')) {
    stderr.write(`Usage: task server:cli -- workspace set <absolute-path>\n`)
    return 2
  }
  const resolved = path.resolve(target)
  ensureHomeLayout(resolved)
  const pointerPath = defaultPointerPath()
  try {
    writeHomePointer(resolved, pointerPath)
  } catch (err) {
    stderr.write(
      `Failed to write pointer at ${pointerPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  stdout.write(`Workspace pointer set:\n`)
  stdout.write(`  ${resolved}\n`)
  stdout.write(`  pointer file: ${pointerPath}\n`)
  return 0
}

function cmdWorkspaceReset(): number {
  const pointerPath = defaultPointerPath()
  const before = readHomePointer(pointerPath)
  try {
    deleteHomePointer(pointerPath)
  } catch (err) {
    stderr.write(
      `Failed to delete pointer at ${pointerPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (before) {
    stdout.write(`Pointer file removed (was: ${before}).\n`)
  } else {
    stdout.write(`No pointer file was present.\n`)
  }
  const { home, source } = resolveMoumantaiHomeWithSource()
  stdout.write(`Workspace now resolves to: ${home} (${source}).\n`)
  return 0
}

function pickEditor(): string {
  if (env.VISUAL && env.VISUAL.trim()) return env.VISUAL
  if (env.EDITOR && env.EDITOR.trim()) return env.EDITOR
  return platform === 'win32' ? 'notepad' : 'vi'
}

async function runEditor(editor: string, file: string): Promise<void> {
  // `editor` may include args (e.g., "code --wait"); split on spaces. Keep
  // simple — users with paths-with-spaces in $EDITOR can quote individually.
  const parts = editor.split(/\s+/)
  const program = parts[0]!
  const args = [...parts.slice(1), file]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(program, args, { stdio: 'inherit', shell: false })
    proc.on('error', reject)
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)),
    )
  })
}

/**
 * Find `--flag <value>` in args; return the value or undefined. Doesn't
 * mutate args — caller filters them out positionally if needed.
 */
function takeFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

/**
 * Heuristic: a bare app id has only lowercase letters / digits / hyphens (no
 * slash, no scheme, no dot). Anything else is treated as a path or URL by
 * installApp's own parser.
 */
function looksLikeIdNotPath(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s)
}

/**
 * Resolve an id across all configured registries; install the unique match.
 * On zero matches: error with a hint to add a registry. On multiple matches:
 * error listing each, suggesting `--from <url>` to disambiguate.
 */
function installFromConfiguredRegistries(home: string, id: string): ReturnType<typeof installApp> {
  const layout = homeLayout(home)
  const file = loadConfigFile(layout.configFile)
  if (file.appRegistries.length === 0) {
    throw new Error(
      `No registries configured. Add one: task server:cli -- registry add <name> <url>\n` +
        `  Or install from a URL directly: task server:cli -- app install <url>`,
    )
  }
  const matches: { name: string; source: import('./workspace/apps-installer.js').InstallSource }[] =
    []
  for (const r of file.appRegistries) {
    try {
      const reg = fetchRegistry(home, r.url)
      const entry = reg.registry.apps.find((a) => a.id === id)
      if (entry) matches.push({ name: r.name, source: resolveAppFromRegistry(reg, id) })
    } catch (err) {
      // Surface registry-fetch errors but don't abort — try the rest.
      stderr.write(`registry "${r.name}": ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `App "${id}" not found in any configured registry (${file.appRegistries.map((r) => r.name).join(', ')}).`,
    )
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `  ${m.name}: ${formatSource(m.source)}`).join('\n')
    throw new Error(`App "${id}" found in multiple registries — disambiguate with --from:\n${list}`)
  }
  return installApp(home, matches[0]!.source)
}

function formatSource(s: import('./workspace/apps-installer.js').InstallSource): string {
  if (s.kind === 'local') return s.path
  return s.subdir ? `${s.url}#${s.ref}:${s.subdir}` : `${s.url}#${s.ref}`
}

// ---------------------------------------------------------------------------
// registry add / list / remove / update
// ---------------------------------------------------------------------------

async function cmdRegistry(sub: string | undefined, args: string[]): Promise<number> {
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const layout = homeLayout(home)

  switch (sub) {
    case 'add': {
      const [name, url] = args
      if (!name || !url) {
        stderr.write(`Usage: task server:cli -- registry add <name> <url>\n`)
        return 2
      }
      const file = loadConfigFile(layout.configFile)
      if (file.appRegistries.some((r) => r.name === name)) {
        stderr.write(
          `Registry "${name}" already configured. Remove first: task server:cli -- registry remove ${name}\n`,
        )
        return 1
      }
      file.appRegistries.push({ name, url })
      writeConfigFile(layout.configFile, file)
      stdout.write(`Added registry "${name}" → ${url}\n`)
      // Eagerly fetch so the user sees errors immediately.
      try {
        const reg = fetchRegistry(home, url)
        stdout.write(`  ${reg.registry.apps.length} app(s) available.\n`)
      } catch (err) {
        stderr.write(`Warning: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      return 0
    }
    case 'list': {
      const file = loadConfigFile(layout.configFile)
      if (file.appRegistries.length === 0) {
        stdout.write(
          `No registries configured.\n  Add one: task server:cli -- registry add <name> <url>\n`,
        )
        return 0
      }
      for (const r of file.appRegistries) {
        stdout.write(`  ${r.name.padEnd(20)} ${r.url}\n`)
      }
      return 0
    }
    case 'remove': {
      const name = args[0]
      if (!name) {
        stderr.write(`Usage: task server:cli -- registry remove <name>\n`)
        return 2
      }
      const file = loadConfigFile(layout.configFile)
      const before = file.appRegistries.length
      file.appRegistries = file.appRegistries.filter((r) => r.name !== name)
      if (file.appRegistries.length === before) {
        stderr.write(`No registry "${name}" configured.\n`)
        return 1
      }
      writeConfigFile(layout.configFile, file)
      stdout.write(`Removed registry "${name}".\n`)
      return 0
    }
    case 'update': {
      const name = args[0]
      const file = loadConfigFile(layout.configFile)
      const targets = name ? file.appRegistries.filter((r) => r.name === name) : file.appRegistries
      if (name && targets.length === 0) {
        stderr.write(`No registry "${name}" configured.\n`)
        return 1
      }
      for (const r of targets) {
        try {
          const reg = fetchRegistry(home, r.url)
          stdout.write(`  ${r.name}: ${reg.registry.apps.length} app(s)\n`)
        } catch (err) {
          stderr.write(`  ${r.name}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
      return 0
    }
    default:
      stderr.write(`Unknown registry subcommand: ${sub ?? '(missing)'}\n`)
      printHelp()
      return 2
  }
}

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------

async function cmdDb(sub: string | undefined, args: string[]): Promise<number> {
  switch (sub) {
    case 'purge':
      return await cmdDbPurge(args)
    default:
      stderr.write(`Unknown db subcommand: ${sub ?? '(missing)'}\n`)
      printHelp()
      return 2
  }
}

/**
 * `task server:cli -- db purge --older-than <Nd>` — delete archived conversations
 * and their messages older than N days. Active conversations are never
 * touched. Required flag: `--older-than <Nd>` (e.g. `--older-than 90d`).
 */
async function cmdDbPurge(args: string[]): Promise<number> {
  let olderThanDays: number | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--older-than') {
      const raw = args[i + 1]
      if (!raw) {
        stderr.write('Missing value after --older-than (e.g. --older-than 90d)\n')
        return 2
      }
      const m = /^(\d+)d?$/.exec(raw)
      if (!m) {
        stderr.write(`Invalid --older-than value: ${raw} (expected NN or NNd)\n`)
        return 2
      }
      olderThanDays = parseInt(m[1]!, 10)
      i++
    }
  }
  if (olderThanDays === null) {
    stderr.write('Missing --older-than <Nd> flag.\n')
    stderr.write('Example: task server:cli -- db purge --older-than 90d\n')
    return 2
  }
  if (olderThanDays < 1) {
    stderr.write(`Invalid --older-than: ${olderThanDays} (must be >= 1)\n`)
    return 2
  }

  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const platformDb = openPlatformDb(home)
  const store = new ConversationStore(platformDb)
  const r = store.purgeArchivedOlderThan(olderThanDays)
  stdout.write(
    `Purged ${r.conversationsDeleted} archived conversation(s) and ${r.messagesDeleted} message(s) older than ${olderThanDays} day(s).\n`,
  )
  // Drop free pages while we're here.
  try {
    const client = getNativeClient(platformDb)
    if (r.conversationsDeleted > 0) client?.exec?.('VACUUM')
    client?.close?.()
  } catch {
    /* close failure non-fatal */
  }
  return 0
}

// ---------------------------------------------------------------------------
// device — pairing (allowlist) management
// ---------------------------------------------------------------------------

async function cmdDevice(sub: string | undefined, args: string[]): Promise<number> {
  switch (sub) {
    case 'pair':
      return await cmdDevicePair(args)
    case 'list':
      return cmdDeviceList(args)
    case 'approve':
      return cmdDeviceApprove(args)
    case 'revoke':
      return cmdDeviceRevoke(args)
    case 'forget':
      return cmdDeviceForget(args)
    case 'rename':
      return cmdDeviceRename(args)
    case 'prune':
      return await cmdDevicePrune(args)
    default:
      stderr.write(`Unknown device subcommand: ${sub ?? '(missing)'}\n`)
      stderr.write('Try: pair | list | approve | revoke | forget | rename | prune\n')
      return 2
  }
}

/** Open the platform DB + store for a one-shot CLI command. */
function openStore(): { store: ConversationStore; close: () => void } {
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const platformDb = openPlatformDb(home)
  const store = new ConversationStore(platformDb)
  return {
    store,
    close: () => {
      try {
        getNativeClient(platformDb)?.close?.()
      } catch {
        /* non-fatal */
      }
    },
  }
}

/** First non-flag positional = token; `--name <label>` optional. */
function parseDeviceArgs(args: string[]): { token?: string; name?: string } {
  let token: string | undefined
  let name: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--name') {
      name = args[++i]
      continue
    }
    if (!a.startsWith('--') && token === undefined) {
      token = a
    }
  }
  return { token, name }
}

function deviceClassLabel(n: number | null | undefined): string {
  if (n == null) return '-'
  return (DeviceClass[n] as string | undefined) ?? String(n)
}

/** Compact platform hint from the handshake User-Agent for `device list`. */
function uaShort(ua: string | null | undefined): string {
  if (!ua) return '-'
  if (/okhttp/i.test(ua)) return 'okhttp'
  if (/iPhone|iPad|iOS/i.test(ua)) return 'iOS Safari'
  if (/Android|Wear/i.test(ua)) return 'Android'
  if (/esp/i.test(ua)) return 'esp32'
  if (/Chrome/i.test(ua)) return 'Chrome'
  if (/Firefox/i.test(ua)) return 'Firefox'
  if (/Safari/i.test(ua)) return 'Safari'
  return ua.length > 16 ? ua.slice(0, 15) + '…' : ua
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!isFinite(ms)) return '-'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const fmt = (cols: string[]): string =>
    cols
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd()
  stdout.write(fmt(headers) + '\n')
  for (const r of rows) stdout.write(fmt(r) + '\n')
}

/**
 * Resolve a CLI token (full deviceId or last-4 code) to a single device row.
 * Prints candidates + returns 'ambiguous' on a shared code; null on no match.
 */
function resolveDeviceArg(store: ConversationStore, token: string): Device | 'ambiguous' | null {
  const all = store.listDevices({ includeOldPending: true })
  const exact = all.find((d) => d.deviceId === token)
  if (exact) return exact
  const code = token.toUpperCase()
  const matches = all.filter((d) => deviceCode(d.deviceId) === code)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    stderr.write(`Ambiguous code '${token}' matches ${matches.length} devices:\n`)
    for (const d of matches) {
      stderr.write(`  ${d.deviceId}  ${deviceClassLabel(d.deviceClass)}  ${d.deviceLabel ?? ''}\n`)
    }
    stderr.write('Re-run with the full deviceId.\n')
    return 'ambiguous'
  }
  return null
}

async function cmdDevicePair(args: string[]): Promise<number> {
  let minutes = 5
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--minutes') {
      const m = /^(\d+)$/.exec(args[++i] ?? '')
      if (!m) {
        stderr.write('Invalid --minutes value.\n')
        return 2
      }
      minutes = parseInt(m[1]!, 10)
    }
  }
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)
  const { store, close } = openStore()
  const until = openPairingWindow(home, minutes)
  stdout.write(`Enrollment window open for ${minutes} min (until ${until.toLocaleTimeString()}).\n`)
  stdout.write('Power on the device(s) to pair. Match the code on the device screen, then:\n')
  stdout.write(
    '  approve <code> [name]   pair that device      |   <Enter>  refresh   |   q  quit\n',
  )
  try {
    for (;;) {
      if (pairingWindowExpiry(home) === null) {
        stdout.write('\nEnrollment window expired.\n')
        break
      }
      const pending = store.listDevices({ includeOldPending: true }).filter((d) => !d.paired)
      stdout.write('\n')
      if (pending.length === 0) {
        stdout.write('(nothing pending yet — power on a device, then press Enter to refresh)\n')
      } else {
        printTable(
          ['CODE', 'CLASS', 'SIZE', 'PLATFORM', 'LAST SEEN'],
          pending.map((d) => [
            deviceCode(d.deviceId),
            deviceClassLabel(d.deviceClass),
            d.deviceProfileWidth && d.deviceProfileHeight
              ? `${d.deviceProfileWidth}x${d.deviceProfileHeight}`
              : '-',
            uaShort(d.deviceUa),
            relTime(d.lastSeenAt),
          ]),
        )
      }
      const line = (await prompt('pair> ')).trim()
      if (line === 'q' || line === 'quit') break
      if (line === '') continue // refresh
      if (line.startsWith('approve')) {
        const rest = line.replace(/^approve\s*/, '').trim()
        const parts = rest.split(/\s+/).filter(Boolean)
        const tok = parts.shift()
        const name = parts.join(' ').replace(/^"|"$/g, '') || undefined
        if (!tok) {
          stderr.write('Usage: approve <code> [name]\n')
          continue
        }
        const d = resolveDeviceArg(store, tok)
        if (d === 'ambiguous') continue
        if (!d) {
          stderr.write(`No device matching '${tok}'.\n`)
          continue
        }
        store.setDevicePaired(d.deviceId, true, name)
        stdout.write(
          `Paired ${deviceCode(d.deviceId)}${name ? ` — "${name}"` : ''}. It will connect within a few seconds.\n`,
        )
      } else {
        stderr.write('Commands: approve <code> [name] | <Enter> refresh | q quit\n')
      }
    }
  } finally {
    closePairingWindow(home)
    close()
    stdout.write('Enrollment window closed.\n')
  }
  return 0
}

function cmdDeviceList(args: string[]): number {
  const includeOldPending = args.includes('--all')
  const { store, close } = openStore()
  try {
    const devices = store.listDevices({ includeOldPending })
    if (devices.length === 0) {
      stdout.write(
        includeOldPending
          ? 'No devices.\n'
          : 'No devices (try --all to include old pending probes).\n',
      )
      return 0
    }
    const codeCounts = new Map<string, number>()
    for (const d of devices) {
      const c = deviceCode(d.deviceId)
      codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1)
    }
    const rows = devices.map((d) => {
      const c = deviceCode(d.deviceId)
      const ambiguous = (codeCounts.get(c) ?? 0) > 1
      return [
        d.paired ? 'PAIRED' : 'PENDING',
        ambiguous ? `${c}*` : c,
        deviceClassLabel(d.deviceClass),
        d.deviceProfileWidth && d.deviceProfileHeight
          ? `${d.deviceProfileWidth}x${d.deviceProfileHeight}`
          : '-',
        uaShort(d.deviceUa),
        d.deviceLabel ?? '-',
        relTime(d.lastSeenAt),
      ]
    })
    printTable(['STATUS', 'CODE', 'CLASS', 'SIZE', 'PLATFORM', 'NAME', 'LAST SEEN'], rows)
    if ([...codeCounts.values()].some((n) => n > 1)) {
      stdout.write('\n* code shared by multiple devices — use the full deviceId to disambiguate.\n')
    }
    const pending = devices.filter((d) => !d.paired).length
    if (pending > 0)
      stdout.write(`\n${pending} pending. Approve with: task server:cli -- device approve <code>\n`)
    return 0
  } finally {
    close()
  }
}

function cmdDeviceApprove(args: string[]): number {
  const { token, name } = parseDeviceArgs(args)
  if (!token) {
    stderr.write('Usage: task server:cli -- device approve <code|deviceId> [--name <label>]\n')
    return 2
  }
  const { store, close } = openStore()
  try {
    const d = resolveDeviceArg(store, token)
    if (d === 'ambiguous') return 2
    if (!d) {
      stderr.write(`No device matching '${token}'.\n`)
      return 1
    }
    const was = d.paired
    store.setDevicePaired(d.deviceId, true, name)
    const label = name ?? d.deviceLabel
    stdout.write(
      `${was ? 'Already paired' : 'Paired'}: ${deviceCode(d.deviceId)} (${d.deviceId})${label ? ` — "${label}"` : ''}\n`,
    )
    return 0
  } finally {
    close()
  }
}

function cmdDeviceRevoke(args: string[]): number {
  const { token } = parseDeviceArgs(args)
  if (!token) {
    stderr.write('Usage: task server:cli -- device revoke <code|deviceId>\n')
    return 2
  }
  const { store, close } = openStore()
  try {
    const d = resolveDeviceArg(store, token)
    if (d === 'ambiguous') return 2
    if (!d) {
      stderr.write(`No device matching '${token}'.\n`)
      return 1
    }
    if (!d.paired) {
      stdout.write(`Already not paired: ${deviceCode(d.deviceId)} (${d.deviceId}).\n`)
      return 0
    }
    store.setDevicePaired(d.deviceId, false)
    stdout.write(`Revoked: ${deviceCode(d.deviceId)} (${d.deviceId}).\n`)
    const ageMs = Date.now() - Date.parse(d.lastSeenAt)
    if (isFinite(ageMs) && ageMs < 60_000) {
      stdout.write(
        `  Note: last seen ${Math.round(ageMs / 1000)}s ago and may still be connected — revocation takes effect on its next reconnect; restart the server to force-disconnect now.\n`,
      )
    }
    return 0
  } finally {
    close()
  }
}

function cmdDeviceForget(args: string[]): number {
  const { token } = parseDeviceArgs(args)
  if (!token) {
    stderr.write('Usage: task server:cli -- device forget <code|deviceId>\n')
    return 2
  }
  const { store, close } = openStore()
  try {
    const d = resolveDeviceArg(store, token)
    if (d === 'ambiguous') return 2
    if (!d) {
      stderr.write(`No device matching '${token}'.\n`)
      return 1
    }
    store.forgetDevice(d.deviceId)
    stdout.write(
      `Forgotten (row deleted): ${deviceCode(d.deviceId)} (${d.deviceId}). It will return as pending if it reconnects.\n`,
    )
    return 0
  } finally {
    close()
  }
}

function cmdDeviceRename(args: string[]): number {
  const token = args[0]
  const name = args.slice(1).join(' ').trim()
  if (!token || !name) {
    stderr.write('Usage: task server:cli -- device rename <code|deviceId> <name>\n')
    return 2
  }
  const { store, close } = openStore()
  try {
    const d = resolveDeviceArg(store, token)
    if (d === 'ambiguous') return 2
    if (!d) {
      stderr.write(`No device matching '${token}'.\n`)
      return 1
    }
    store.renameDevice(d.deviceId, name)
    stdout.write(`Renamed ${deviceCode(d.deviceId)} (${d.deviceId}) → "${name}".\n`)
    return 0
  } finally {
    close()
  }
}

async function cmdDevicePrune(args: string[]): Promise<number> {
  let all = false
  let unpaired = false
  let yes = false
  let olderThanDays: number | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--all') all = true
    else if (a === '--unpaired') unpaired = true
    else if (a === '--yes' || a === '-y') yes = true
    else if (a === '--older-than') {
      const raw = args[++i]
      const m = raw ? /^(\d+)d?$/.exec(raw) : null
      if (!m) {
        stderr.write('Invalid --older-than value (expected NN or NNd).\n')
        return 2
      }
      olderThanDays = parseInt(m[1]!, 10)
    }
  }
  if (!all && !unpaired && olderThanDays == null) {
    stderr.write('Specify what to prune:\n')
    stderr.write(
      '  task server:cli -- device prune --older-than <Nd>   delete devices not seen in N days\n',
    )
    stderr.write(
      '  task server:cli -- device prune --unpaired          delete pending (un-approved) devices\n',
    )
    stderr.write(
      '  task server:cli -- device prune --all               delete ALL device rows (wipe)\n',
    )
    stderr.write('Add --yes to skip the confirmation prompt.\n')
    return 2
  }

  const { store, close } = openStore()
  try {
    // Preview the count using the same predicate the store will apply.
    const cutoff = olderThanDays != null ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null
    const allRows = store.listDevices({ includeOldPending: true })
    const victims = all
      ? allRows
      : allRows.filter(
          (d) => (unpaired && !d.paired) || (cutoff != null && Date.parse(d.lastSeenAt) < cutoff),
        )
    if (victims.length === 0) {
      stdout.write('Nothing to prune.\n')
      return 0
    }

    const pairedCount = victims.filter((d) => d.paired).length
    const desc = all
      ? `ALL ${victims.length} device(s)`
      : `${victims.length} device(s)` +
        (olderThanDays != null ? ` not seen in ${olderThanDays}d` : '') +
        (unpaired ? `${olderThanDays != null ? ' or' : ''} unpaired` : '')
    if (!yes) {
      const ans = await prompt(
        `Delete ${desc}${pairedCount ? ` (including ${pairedCount} PAIRED — they'll need re-approval)` : ''}? [y/N] `,
      )
      if (ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
        stdout.write('Aborted.\n')
        return 0
      }
    }
    const deleted = store.pruneDevices({
      all,
      unpaired,
      ...(olderThanDays != null ? { olderThanDays } : {}),
    })
    stdout.write(`Pruned ${deleted} device(s).\n`)
    return 0
  } finally {
    close()
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// app install / uninstall / list
// ---------------------------------------------------------------------------

async function cmdApp(sub: string | undefined, args: string[]): Promise<number> {
  const home = resolveMoumantaiHome()
  ensureHomeLayout(home)

  switch (sub) {
    case 'install': {
      const fromUrl = takeFlagValue(args, '--from')
      const positional = args.filter((a) => a !== '--from' && a !== fromUrl)
      const target = positional[0]
      if (!target) {
        stderr.write(`Usage: task server:cli -- app install <path|url|id> [--from <registry>]\n`)
        return 2
      }

      let result: ReturnType<typeof installApp>
      if (fromUrl) {
        // Explicit registry: resolve <id> via fetchRegistry.
        const reg = fetchRegistry(home, fromUrl)
        const source = resolveAppFromRegistry(reg, target)
        result = installApp(home, source)
      } else if (looksLikeIdNotPath(target)) {
        // Bare id (no slash, no scheme) → resolve across configured registries.
        result = installFromConfiguredRegistries(home, target)
      } else {
        result = installApp(home, target)
      }
      const where =
        result.origin.type === 'git'
          ? `git ${result.origin.url}@${result.origin.commit.slice(0, 7)}`
          : `local ${result.origin.linkType}`
      stdout.write(`Installed "${result.id}" ${result.version} (${where}).\n`)
      if (result.warning) stderr.write(`Warning: ${result.warning}\n`)
      return 0
    }
    case 'search': {
      const query = args[0]
      if (!query) {
        stderr.write(`Usage: task server:cli -- app search <query>\n`)
        return 2
      }
      const layout = homeLayout(home)
      const file = loadConfigFile(layout.configFile)
      if (file.appRegistries.length === 0) {
        stderr.write(
          `No registries configured. Add one: task server:cli -- registry add <name> <url>\n`,
        )
        return 1
      }
      const q = query.toLowerCase()
      let matched = 0
      for (const r of file.appRegistries) {
        try {
          const reg = fetchRegistry(home, r.url)
          for (const a of reg.registry.apps) {
            const hay = `${a.id} ${a.description ?? ''}`.toLowerCase()
            if (hay.includes(q)) {
              const desc = a.description ? `  — ${a.description}` : ''
              stdout.write(`  ${a.id.padEnd(20)} ${a.version.padEnd(10)} (${r.name})${desc}\n`)
              matched++
            }
          }
        } catch (err) {
          stderr.write(
            `registry "${r.name}": ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
      if (matched === 0) stdout.write(`No apps matching "${query}".\n`)
      return 0
    }
    case 'update': {
      const id = args[0]
      const ids = id ? [id] : listInstalled(home).map((a) => a.id)
      if (ids.length === 0) {
        stdout.write(`No apps to update.\n`)
        return 0
      }
      let exitCode = 0
      for (const target of ids) {
        try {
          const r = updateApp(home, target)
          if (r.updated) {
            stdout.write(
              `${target}: ${r.fromVersion} → ${r.toVersion} (${r.fromCommit?.slice(0, 7)} → ${r.toCommit?.slice(0, 7)})\n`,
            )
          } else {
            stdout.write(`${target}: ${r.reason ?? 'no change'}\n`)
          }
        } catch (err) {
          exitCode = 1
          stderr.write(`${target}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
      return exitCode
    }
    case 'uninstall': {
      const id = args[0]
      if (!id) {
        stderr.write(`Usage: task server:cli -- app uninstall <id> [--force]\n`)
        return 2
      }
      const force = args.includes('--force')
      const result = uninstallApp(home, id)
      if (!result.removedSrc) {
        stderr.write(`No app source for "${id}" at ${path.join(home, 'apps-src', id)}\n`)
      } else {
        stdout.write(`Removed source: ${path.join(home, 'apps-src', id)}\n`)
      }
      if (result.hasRuntimeState) {
        const ok =
          force ||
          (stdin.isTTY &&
            /^y(es)?$/i.test(
              await prompt(
                `Also delete runtime data at ${result.runtimeStateDir}? This wipes the app's DB. [y/N] `,
              ),
            ))
        if (ok) {
          deleteAppRuntimeState(home, id)
          // Drop per-app face_params rows in platform.db. Skips when the
          // platform DB hasn't been created yet (fresh install with no runs).
          try {
            if (fs.existsSync(homeLayout(home).platformDb)) {
              const dropped = new FaceParamsStore(openPlatformDb(home)).deleteByApp(id)
              if (dropped > 0) {
                stdout.write(`Cleared ${dropped} face_params row(s) for "${id}"\n`)
              }
            }
          } catch (err) {
            stderr.write(
              `Warning: failed to clean face_params for "${id}": ${err instanceof Error ? err.message : String(err)}\n`,
            )
          }
          stdout.write(`Removed runtime data: ${result.runtimeStateDir}\n`)
        } else {
          stdout.write(`Kept runtime data: ${result.runtimeStateDir}\n`)
        }
      }
      return 0
    }
    case 'list': {
      const fromUrl = takeFlagValue(args, '--from')
      if (fromUrl) {
        const reg = fetchRegistry(home, fromUrl)
        stdout.write(
          `Registry: ${reg.registry.name} (schema v${reg.registry.version}) at ${fromUrl}\n`,
        )
        if (reg.registry.apps.length === 0) {
          stdout.write(`  (no apps listed)\n`)
          return 0
        }
        for (const a of reg.registry.apps) {
          const desc = a.description ? `  — ${a.description}` : ''
          stdout.write(`  ${a.id.padEnd(20)} ${a.version.padEnd(10)}${desc}\n`)
        }
        return 0
      }
      const apps = listInstalled(home)
      if (apps.length === 0) {
        stdout.write(`No apps installed.\n`)
        stdout.write(`  Install one: task server:cli -- app install <path|url>\n`)
        return 0
      }
      for (const a of apps) {
        const where =
          a.origin?.type === 'git'
            ? `git ${a.origin.url}@${a.origin.ref} (${a.origin.commit.slice(0, 7)})`
            : a.origin?.type === 'local'
              ? `local ${a.origin.linkType}: ${a.origin.source}`
              : a.type === 'link' && a.target
                ? `link -> ${a.target}`
                : a.type
        stdout.write(`  ${a.id.padEnd(20)} ${a.version.padEnd(10)} ${where}\n`)
      }
      return 0
    }
    case 'configure': {
      const id = args[0]
      if (!id) {
        stderr.write(`Usage: task server:cli -- app configure <id>\n`)
        return 2
      }
      // Resolve the app's source dir. Falls back to <home>/apps-src/<id>/ even
      // if not installed — saveAppContext writes under <home>/apps/<id>/.
      const candidateDirs = [path.join(home, 'apps-src', id)]
      let appDir: string | undefined
      for (const d of candidateDirs) {
        if (fs.existsSync(d) && findEntryFile(d)) {
          appDir = d
          break
        }
      }
      if (!appDir) {
        stderr.write(
          `No source for app "${id}". Install first: task server:cli -- app install <id>\n`,
        )
        return 1
      }
      const entry = findEntryFile(appDir)!
      const raw = await loadAppModule(entry)
      const appDef = validateAppDef(raw, entry)

      await promptAppConfigWizard({
        io: { home, stdout, stderr, stdin },
        appId: id,
        ...(appDef.config !== undefined ? { configSchema: appDef.config } : {}),
        ...(appDef.context !== undefined ? { contextSchema: appDef.context } : {}),
      })
      return 0
    }
    case 'cache-clear': {
      const id = args[0]
      if (!id) {
        stderr.write(`Usage: task server:cli -- app cache-clear <id> [--yes]\n`)
        return 2
      }
      const force = args.includes('--yes')
      const assetsDir = path.join(home, 'apps', id, 'assets')
      if (!fs.existsSync(assetsDir)) {
        stdout.write(`No asset cache at ${assetsDir}\n`)
        return 0
      }
      const ok =
        force ||
        (stdin.isTTY &&
          /^y(es)?$/i.test(
            await prompt(`Delete asset cache at ${assetsDir}? Next refresh repopulates. [y/N] `),
          ))
      if (!ok) {
        stdout.write(`Kept asset cache.\n`)
        return 0
      }
      fs.rmSync(assetsDir, { recursive: true, force: true })
      stdout.write(`Cleared asset cache: ${assetsDir}\n`)
      return 0
    }
    default:
      stderr.write(`Unknown app subcommand: ${sub ?? '(missing)'}\n`)
      printHelp()
      return 2
  }
}

// ---------------------------------------------------------------------------
// Module entry: `node cli.ts ...` or `tsx cli.ts ...`
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${path.resolve(process.argv[1] ?? '')}` ||
  import.meta.url.endsWith(path.basename(process.argv[1] ?? ''))

if (isMain) {
  runCli(process.argv.slice(2)).then((code) => exit(code))
}
