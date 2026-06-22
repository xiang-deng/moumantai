/**
 * Interactive setup wizard. Walks the user through Anthropic-credential
 * config, voice setup, port, and app linking. Designed to be safe on re-run:
 * existing values pre-fill prompts; cancelling at any step is a no-op.
 *
 * I/O is parameterized so tests can drive it with a scripted readline-like
 * mock and assert on captured prompts/output.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface, type Interface as RlInterface } from 'node:readline/promises'
import {
  loadConfigFile,
  writeConfigFile,
  ConfigFileSchema,
  type ConfigFile,
} from './config-loader.js'
import { homeLayout, ensureHomeLayout, defaultPointerPath, writeHomePointer } from './home.js'
import { piPaths, type PiPaths } from './pi-layout.js'
import { installApp } from './apps-installer.js'
import {
  checkAnthropicCredential,
  checkOpenAICredential,
  checkGoogleCredential,
} from './credential-check.js'
import { readEnvFile } from './dotenv.js'
import { isZodSchema, getObjectFields } from '../framework/zod-utils.js'
import { isSecretField, getSecretFieldDescription } from '../framework/secret-field.js'
import { saveAppConfig, loadAppConfig } from '../framework/app-config.js'
import { saveAppContext, loadAppContext } from '../framework/app-context.js'
import type { ZodType } from 'zod'

type Backend = 'claude' | 'pi'

type PiProviderId = 'anthropic' | 'openai' | 'openai-codex' | 'google' | 'github-copilot' | 'other'

type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Per-provider model defaults. Update when newer flagships stabilize.
 * `other` has no default — the wizard prompts for free-form input.
 */
const PI_MODEL_DEFAULTS: Record<Exclude<PiProviderId, 'other'>, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.4',
  'openai-codex': 'gpt-5.5',
  google: 'gemini-3.1-pro-preview',
  'github-copilot': 'claude-opus-4.7',
}

const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const

export interface WizardIO {
  home: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream
  /** Override the readline implementation in tests. */
  readline?: RlInterface
  /**
   * Override the workspace-pointer file location. Tests pass a tmp path so
   * they don't pollute the dev's real `~/.config/moumantai/home`. Pass `null`
   * to skip pointer writing entirely. `undefined` uses the platform default.
   */
  pointerPath?: string | null
}

interface PromptCtx {
  rl: RlInterface
  out: NodeJS.WritableStream
}

export async function runWizard(io: WizardIO): Promise<void> {
  const rl = io.readline ?? createInterface({ input: io.stdin, output: io.stdout })
  const ctx: PromptCtx = { rl, out: io.stdout }

  try {
    write(io.stdout, `\nMoumantai setup wizard\n`)

    // 0. Workspace location — stamps the pointer file so all subsequent invocations find it.
    const home = await askWorkspaceLocation(ctx, io)
    ensureHomeLayout(home)
    const layout = homeLayout(home)
    // Shadow io.home with the wizard's choice so downstream helpers see it.
    io = { ...io, home }

    write(io.stdout, `Workspace: ${home}\n\n`)

    const existing = safeLoadConfig(layout.configFile)

    // 1. Backend choice (claude vs pi)
    const backend = await askBackendChoice(ctx, existing.backend)

    // 2. Backend-specific setup. Each branch returns the credential bits
    //    that need writing to <home>/.env, plus (for pi) the nested config block.
    const envWrites: Record<string, string> = {}
    let pi: ConfigFile['pi'] = existing.pi
    let claudeAuthSummary: string | undefined
    let piAuthSummary: string | undefined

    if (backend === 'claude') {
      const claude = await setupClaudeBackend(ctx, io)
      if (claude.anthropicSecret && claude.anthropicEnvVar) {
        envWrites[claude.anthropicEnvVar] = claude.anthropicSecret
        claudeAuthSummary = `${claude.anthropicEnvVar} → <home>/.env`
      } else {
        claudeAuthSummary = 'Anthropic credential unchanged'
      }
    } else {
      const piResult = await setupPiBackend(ctx, io, existing)
      pi = piResult.pi
      Object.assign(envWrites, piResult.envWrites)
      piAuthSummary = piResult.authSummary
    }

    // 3. Voice (optional) — backend-independent; uses OpenAI for STT/TTS.
    let voice = existing.voice
    let openaiSecret: string | undefined
    const setupVoice = await askYesNo(ctx, 'Set up voice (STT + TTS via OpenAI)?', false)
    if (setupVoice) {
      const result = await promptVoiceSetup(ctx, io, voice)
      voice = result.voice
      openaiSecret = result.openaiKey
    }
    if (openaiSecret) envWrites['OPENAI_API_KEY'] = openaiSecret

    // 4. Port
    const port = await askInt(ctx, 'Server port', existing.port, 1, 65535)

    // 4b. Developer mode — gates the coding-agent editing pipeline. Off by default.
    const devMode = await askYesNo(
      ctx,
      'Enable developer mode (coding-agent app/face editing)?',
      existing.devMode,
    )

    // 5. App linking — only when running from a checked-out repo
    const repoApps = detectRepoApps()
    let installedApps: string[] = []
    if (repoApps.length > 0) {
      const link = await askYesNo(
        ctx,
        `Detected ${repoApps.length} repo apps at ${repoApps[0]?.repoApps}. Auto-link them for hot-reload?`,
        true,
      )
      if (link) {
        for (const r of repoApps) {
          for (const appDir of r.dirs) {
            try {
              const result = installApp(io.home, appDir)
              installedApps.push(result.id)
            } catch (err) {
              write(
                io.stderr,
                `  ! Failed to link ${appDir}: ${err instanceof Error ? err.message : err}\n`,
              )
            }
          }
        }
      }
    }

    // 6. Summary + write
    const newConfig = ConfigFileSchema.parse({
      ...existing,
      backend,
      port,
      voice,
      pi,
      devMode,
    })

    write(io.stdout, `\nSummary:\n`)
    write(io.stdout, `  backend = ${newConfig.backend}\n`)
    if (newConfig.backend === 'pi') {
      write(
        io.stdout,
        `  pi      = ${newConfig.pi.provider ?? '(unset)'} / ${newConfig.pi.model ?? '(unset)'}${newConfig.pi.thinkingLevel ? ` / thinking=${newConfig.pi.thinkingLevel}` : ''}\n`,
      )
      if (piAuthSummary) write(io.stdout, `  auth    = ${piAuthSummary}\n`)
    } else if (claudeAuthSummary) {
      write(io.stdout, `  auth    = ${claudeAuthSummary}\n`)
    }
    write(io.stdout, `  port    = ${newConfig.port}\n`)
    write(
      io.stdout,
      `  voice   = ${setupVoice ? `${newConfig.voice.sttModel} / ${newConfig.voice.ttsModel} (${newConfig.voice.ttsVoice})` : 'disabled'}\n`,
    )
    write(io.stdout, `  devMode = ${newConfig.devMode ? 'enabled' : 'disabled'}\n`)
    if (installedApps.length) write(io.stdout, `  apps    = ${installedApps.join(', ')}\n`)
    for (const key of Object.keys(envWrites)) {
      write(io.stdout, `  ${key} → <home>/.env\n`)
    }

    const confirm = await askYesNo(ctx, '\nWrite these settings?', true)
    if (!confirm) {
      write(io.stdout, `Cancelled — no changes written.\n`)
      return
    }

    writeConfigFile(layout.configFile, newConfig)
    if (Object.keys(envWrites).length > 0) {
      mergeEnvFile(layout.envFile, envWrites)
      // Best-effort tighten permissions on Unix.
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(layout.envFile, 0o600)
        } catch {
          /* best-effort */
        }
      }
    }

    write(io.stdout, `\nWorkspace ready at ${io.home}\n`)
    write(io.stdout, `  • Reconfigure:     task server:init                 (re-run this wizard)\n`)
    write(
      io.stdout,
      `  • Edit raw:        task server:cli -- config edit   (opens config.json in $EDITOR)\n`,
    )
    write(io.stdout, `  • View resolved:   task server:cli -- config show\n`)
    write(io.stdout, `  • Start server:    task server:dev\n`)
  } finally {
    // Close ctx.rl (not the local `rl`) — spawnPiForLogin may have replaced it
    // with a fresh instance; closing the stale one would leak the live one.
    if (!io.readline) ctx.rl.close()
  }
}

// ---------------------------------------------------------------------------
// Workspace location (step 0)
// ---------------------------------------------------------------------------

/**
 * Walk up from `startCwd` looking for an ancestor whose
 * `server/package.json` has `name === '@moumantai/server'`.
 * Returns the absolute repo root, or null. More precise than ".git/" detection
 * — avoids false positives from unrelated git projects.
 */
function detectMoumantaiCheckout(startCwd: string): string | null {
  let cur = path.resolve(startCwd)
  for (let depth = 0; depth < 32; depth++) {
    const pkgJson = path.join(cur, 'server', 'package.json')
    try {
      const text = fs.readFileSync(pkgJson, 'utf8')
      const pkg = JSON.parse(text) as { name?: unknown }
      if (pkg.name === '@moumantai/server') return cur
    } catch {
      // not here — keep walking
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

interface WorkspaceOption {
  label: string // short tag for the menu line
  path: string // absolute path
}

/**
 * Ask where the workspace should live. Always stamps the pointer file so
 * subsequent `resolveMoumantaiHome()` calls (cron, systemd, any cwd) find it.
 *
 * Options: [1] ~/.moumantai/ · [2] <repo>/.moumantai/ (if detected) ·
 * [N] current (if io.home differs) · [c] custom path.
 * Default is whichever option matches `io.home`.
 */
async function askWorkspaceLocation(ctx: PromptCtx, io: WizardIO): Promise<string> {
  const userHomeOption = path.join(os.homedir(), '.moumantai')
  const checkoutRoot = detectMoumantaiCheckout(process.cwd())
  const repoLocalOption = checkoutRoot ? path.join(checkoutRoot, '.moumantai') : null

  const options: WorkspaceOption[] = [
    { label: 'user-home — recommended for daily use', path: userHomeOption },
  ]
  if (repoLocalOption) {
    options.push({ label: 'checkout-local — recommended for development', path: repoLocalOption })
  }
  // Surface resolver-suggested home (env var override, explicit arg, …) if not already listed.
  if (!options.some((o) => o.path === io.home)) {
    options.push({ label: 'current (suggested by resolver)', path: io.home })
  }

  // Default to whichever known option matches the suggested home.
  const defaultIdx = options.findIndex((o) => o.path === io.home)
  const defaultPick = (defaultIdx >= 0 ? defaultIdx + 1 : 1).toString()

  write(ctx.out, `\nWorkspace location (where config + chat history + per-app data live):\n`)
  for (let i = 0; i < options.length; i++) {
    write(ctx.out, `  [${i + 1}] ${options[i]!.path}  (${options[i]!.label})\n`)
  }
  write(ctx.out, `  [c] Custom absolute path\n`)

  while (true) {
    const ans = (await ctx.rl.question(`Pick [${defaultPick}]: `)).trim().toLowerCase()
    const effective = ans === '' ? defaultPick : ans
    let chosen: string | null = null

    const numeric = Number(effective)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
      chosen = options[numeric - 1]!.path
    } else if (effective === 'c' || effective === 'custom') {
      const raw = (await ctx.rl.question('  Absolute path: ')).trim()
      if (!raw) {
        write(ctx.out, `  Path can't be empty. Try again.\n`)
        continue
      }
      chosen = path.resolve(raw)
    }

    if (!chosen) {
      write(ctx.out, `  Please enter 1–${options.length} or c.\n`)
      continue
    }

    // Stamp the pointer so this choice survives any cwd at boot.
    // Soft-fail with a warning if the location is read-only.
    if (io.pointerPath !== null) {
      const pointerPath = io.pointerPath ?? defaultPointerPath()
      try {
        writeHomePointer(chosen, pointerPath)
      } catch (err) {
        write(
          io.stderr,
          `\n  ⚠️  Couldn't write workspace pointer at ${pointerPath} ` +
            `(${err instanceof Error ? err.message : String(err)}).\n` +
            `     Set MOUMANTAI_HOME=${chosen} in your shell so the server can find it.\n\n`,
        )
      }
    }
    return chosen
  }
}

// ---------------------------------------------------------------------------
// Backend choice
// ---------------------------------------------------------------------------

async function askBackendChoice(ctx: PromptCtx, current: Backend): Promise<Backend> {
  write(ctx.out, `\nLLM backend:\n`)
  write(ctx.out, `  [1] claude — @anthropic-ai/claude-agent-sdk (direct)\n`)
  write(
    ctx.out,
    `  [2] pi     — @earendil-works/pi-coding-agent (multi-provider: Anthropic, OpenAI, Google, Codex, Copilot, …)\n`,
  )
  const defaultIdx = current === 'pi' ? '2' : '1'
  while (true) {
    const ans = (await ctx.rl.question(`Pick backend [${defaultIdx}]: `)).trim()
    if (ans === '') return current
    if (ans === '1' || ans.toLowerCase() === 'claude') return 'claude'
    if (ans === '2' || ans.toLowerCase() === 'pi') return 'pi'
    write(ctx.out, `  Please enter 1 (claude) or 2 (pi).\n`)
  }
}

// ---------------------------------------------------------------------------
// Backend: Claude
// ---------------------------------------------------------------------------

interface ClaudeSetupResult {
  anthropicSecret?: string
  anthropicEnvVar?: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY'
}

async function setupClaudeBackend(ctx: PromptCtx, io: WizardIO): Promise<ClaudeSetupResult> {
  const anthropicSecret = await promptAnthropicCredential(ctx, io)
  if (!anthropicSecret) return {}
  return {
    anthropicSecret,
    anthropicEnvVar: anthropicEnvVarFor(anthropicSecret),
  }
}

// ---------------------------------------------------------------------------
// Backend: Pi
// ---------------------------------------------------------------------------

interface PiSetupResult {
  pi: ConfigFile['pi']
  envWrites: Record<string, string>
  /** One-liner for the summary block, e.g. "ANTHROPIC_API_KEY → <home>/.env". */
  authSummary?: string
}

async function setupPiBackend(
  ctx: PromptCtx,
  io: WizardIO,
  existing: ConfigFile,
): Promise<PiSetupResult> {
  const layout = homeLayout(io.home)
  const paths = piPaths(io.home)
  fs.mkdirSync(paths.agentDir, { recursive: true })

  const provider = await askPiProvider(ctx, existing.pi.provider as PiProviderId | undefined)
  const model = await askPiModel(ctx, provider, existing.pi.model)
  const thinkingLevel = await askPiThinkingLevel(
    ctx,
    existing.pi.thinkingLevel as PiThinkingLevel | undefined,
  )

  const envWrites: Record<string, string> = {}
  let authSummary: string | undefined

  switch (provider) {
    case 'anthropic':
      authSummary = await promptPiAnthropicCredential(ctx, io, layout.envFile, paths, envWrites)
      break
    case 'openai':
      authSummary = await promptPiOpenAICredential(ctx, io, layout.envFile, envWrites)
      break
    case 'google':
      authSummary = await promptPiGoogleCredential(ctx, io, layout.envFile, envWrites)
      break
    case 'openai-codex':
    case 'github-copilot':
      authSummary = await promptPiOAuthOnly(ctx, io, provider, paths)
      break
    case 'other':
      authSummary = await promptPiOtherCredential(ctx, envWrites)
      break
  }

  return {
    pi: {
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    envWrites,
    ...(authSummary ? { authSummary } : {}),
  }
}

async function askPiProvider(
  ctx: PromptCtx,
  current: PiProviderId | undefined,
): Promise<PiProviderId> {
  write(ctx.out, `\nPi provider:\n`)
  write(ctx.out, `  [1] anthropic       — Claude (API key OR Claude Pro/Max OAuth)\n`)
  write(ctx.out, `  [2] openai          — GPT-5/o-series via API key\n`)
  write(ctx.out, `  [3] openai-codex    — ChatGPT Plus/Pro subscription (OAuth only)\n`)
  write(ctx.out, `  [4] google          — Gemini via API key\n`)
  write(ctx.out, `  [5] github-copilot  — Copilot subscription (OAuth only)\n`)
  write(ctx.out, `  [6] other           — free-form provider id (you set the env var)\n`)

  const map: Record<string, PiProviderId> = {
    '1': 'anthropic',
    anthropic: 'anthropic',
    '2': 'openai',
    openai: 'openai',
    '3': 'openai-codex',
    'openai-codex': 'openai-codex',
    codex: 'openai-codex',
    '4': 'google',
    google: 'google',
    gemini: 'google',
    '5': 'github-copilot',
    'github-copilot': 'github-copilot',
    copilot: 'github-copilot',
    '6': 'other',
    other: 'other',
  }
  const defaultIdx = current
    ? (
        ['anthropic', 'openai', 'openai-codex', 'google', 'github-copilot'].indexOf(current) + 1
      ).toString() || '6'
    : '1'

  while (true) {
    const ans = (await ctx.rl.question(`Pick provider [${defaultIdx}]: `)).trim().toLowerCase()
    if (ans === '' && current) return current
    if (ans === '' && !current) return 'anthropic'
    const pick = map[ans]
    if (pick) return pick
    write(
      ctx.out,
      `  Please enter 1–6 or one of: anthropic / openai / openai-codex / google / github-copilot / other.\n`,
    )
  }
}

async function askPiModel(
  ctx: PromptCtx,
  provider: PiProviderId,
  current: string | undefined,
): Promise<string> {
  const fallback = provider === 'other' ? '' : PI_MODEL_DEFAULTS[provider]
  const def = current ?? fallback
  const label = def ? ` [${def}]` : ` (e.g. gpt-4o, claude-opus-4-7)`
  while (true) {
    const ans = (await ctx.rl.question(`Pi model${label}: `)).trim()
    if (ans !== '') return ans
    if (def) return def
    write(ctx.out, `  Please enter a model id (no default for provider "${provider}").\n`)
  }
}

async function askPiThinkingLevel(
  ctx: PromptCtx,
  current: PiThinkingLevel | undefined,
): Promise<PiThinkingLevel | undefined> {
  const def = current ?? 'medium'
  while (true) {
    const ans = (
      await ctx.rl.question(`Thinking level (off/minimal/low/medium/high/xhigh) [${def}]: `)
    )
      .trim()
      .toLowerCase()
    if (ans === '') return def
    if ((PI_THINKING_LEVELS as readonly string[]).includes(ans)) {
      return ans as PiThinkingLevel
    }
    write(ctx.out, `  Please enter one of: ${PI_THINKING_LEVELS.join(' / ')}.\n`)
  }
}

// ---------------------------------------------------------------------------
// Pi credential prompts (per-provider)
// ---------------------------------------------------------------------------

async function promptPiAnthropicCredential(
  ctx: PromptCtx,
  io: WizardIO,
  envFile: string,
  paths: PiPaths,
  envWrites: Record<string, string>,
): Promise<string> {
  // Detect in priority order: env > .env > auth.json.
  const fromEnv = (key: string) => process.env[key] || readEnvKey(envFile, key)
  const apiKey = fromEnv('ANTHROPIC_API_KEY')
  const piOAuthEnv = fromEnv('ANTHROPIC_OAUTH_TOKEN')
  const claudeOAuthEnv = fromEnv('CLAUDE_CODE_OAUTH_TOKEN')
  const authJson = checkPiProviderAuth(paths.authFile, 'anthropic')

  // a) Existing Pi-friendly key in env — reuse silently.
  if (apiKey) {
    write(ctx.out, `\n  Found ANTHROPIC_API_KEY in env. Pi will use it.\n`)
    return 'ANTHROPIC_API_KEY (existing)'
  }

  // b) Pi's own OAuth env var already set — reuse silently.
  if (piOAuthEnv) {
    write(ctx.out, `\n  Found ANTHROPIC_OAUTH_TOKEN in env. Pi will use it.\n`)
    return 'ANTHROPIC_OAUTH_TOKEN (existing)'
  }

  // c) Claude Code OAuth token — offer to mirror (default Y).
  if (claudeOAuthEnv) {
    write(ctx.out, `\n  Found a Claude Code OAuth token (CLAUDE_CODE_OAUTH_TOKEN).\n`)
    write(ctx.out, `  Pi needs the same value under ANTHROPIC_OAUTH_TOKEN.\n`)
    write(
      ctx.out,
      `  Note: Pi requests bill per-token as "extra usage", not from your Claude Pro/Max plan.\n`,
    )
    const mirror = await askYesNo(ctx, '  Mirror it to ANTHROPIC_OAUTH_TOKEN?', true)
    if (mirror) {
      envWrites['ANTHROPIC_OAUTH_TOKEN'] = claudeOAuthEnv
      return 'ANTHROPIC_OAUTH_TOKEN (mirrored from CLAUDE_CODE_OAUTH_TOKEN)'
    }
    // Fall through — user said no, see if auth.json or menu helps.
  }

  // d) auth.json already has anthropic — reuse.
  if (authJson.found && !authJson.expired) {
    const exp = authJson.expires
      ? ` (expires ${new Date(authJson.expires).toISOString().slice(0, 10)})`
      : ''
    write(
      ctx.out,
      `\n  ${paths.authFile} already has Anthropic ${authJson.type}${exp}. Pi will use it.\n`,
    )
    return `auth.json[anthropic]${exp}`
  }
  if (authJson.found && authJson.expired) {
    write(
      ctx.out,
      `\n  ⚠️  ${paths.authFile} has an Anthropic entry but it's expired. Falling through to setup.\n`,
    )
  }

  // e) Nothing usable — present menu.
  return await piAnthropicSetupMenu(ctx, io, paths, envWrites)
}

async function piAnthropicSetupMenu(
  ctx: PromptCtx,
  io: WizardIO,
  paths: PiPaths,
  envWrites: Record<string, string>,
): Promise<string> {
  while (true) {
    write(ctx.out, `\n  How do you want to authenticate?\n`)
    write(ctx.out, `    [1] Paste an Anthropic API key (sk-ant-api-…) — works for Claude SDK too\n`)
    write(
      ctx.out,
      `    [2] Claude Pro/Max OAuth (launches pi here for /login) — Pi-only, billed per-token\n`,
    )
    write(ctx.out, `    [s] Skip — I'll set credentials up later\n`)
    const ans = (await ctx.rl.question('  Pick [1/2/s]: ')).trim().toLowerCase()

    if (ans === '1') {
      const key = await askKeyWithValidation(
        ctx,
        '  Anthropic API key (sk-ant-api-…): ',
        checkAnthropicCredential,
      )
      if (!key) continue
      envWrites['ANTHROPIC_API_KEY'] = key
      return 'ANTHROPIC_API_KEY → <home>/.env'
    }

    if (ans === '2') {
      const result = await spawnPiForLogin(paths, 'anthropic', ctx, io)
      if (result.ok) {
        const exp = result.expires
          ? ` (expires ${new Date(result.expires).toISOString().slice(0, 10)})`
          : ''
        return `auth.json[anthropic]${exp}`
      }
      // Spawn returned without a usable credential — loop back to menu.
      const retry = await askYesNo(ctx, '  Try again?', false)
      if (!retry) continue
      // Loop returns to top of menu so user can pick 1 or s instead.
      continue
    }

    if (ans === 's' || ans === 'skip') {
      write(
        io.stderr,
        `\n  ⚠️  Skipping credential setup. The server will refuse to handle\n` +
          `     turns until you set an Anthropic credential. Re-run\n` +
          `     \`task server:cli -- init\` when you're ready.\n\n`,
      )
      return '(skipped — none configured)'
    }

    write(ctx.out, `  Please enter 1, 2, or s.\n`)
  }
}

async function promptPiOpenAICredential(
  ctx: PromptCtx,
  io: WizardIO,
  envFile: string,
  envWrites: Record<string, string>,
): Promise<string> {
  const existing = process.env.OPENAI_API_KEY || readEnvKey(envFile, 'OPENAI_API_KEY')
  if (existing) {
    write(ctx.out, `\n  Found OPENAI_API_KEY in env. Pi will use it.\n`)
    return 'OPENAI_API_KEY (existing)'
  }
  const key = await askKeyWithValidation(ctx, '\n  OpenAI API key (sk-…): ', checkOpenAICredential)
  if (!key) {
    write(io.stderr, `\n  ⚠️  No OPENAI_API_KEY set. The server will fail at first turn.\n\n`)
    return '(skipped — none configured)'
  }
  envWrites['OPENAI_API_KEY'] = key
  return 'OPENAI_API_KEY → <home>/.env'
}

async function promptPiGoogleCredential(
  ctx: PromptCtx,
  io: WizardIO,
  envFile: string,
  envWrites: Record<string, string>,
): Promise<string> {
  const existing = process.env.GEMINI_API_KEY || readEnvKey(envFile, 'GEMINI_API_KEY')
  if (existing) {
    write(ctx.out, `\n  Found GEMINI_API_KEY in env. Pi will use it.\n`)
    return 'GEMINI_API_KEY (existing)'
  }
  const key = await askKeyWithValidation(
    ctx,
    '\n  Gemini API key (from AI Studio): ',
    checkGoogleCredential,
  )
  if (!key) {
    write(io.stderr, `\n  ⚠️  No GEMINI_API_KEY set. The server will fail at first turn.\n\n`)
    return '(skipped — none configured)'
  }
  envWrites['GEMINI_API_KEY'] = key
  return 'GEMINI_API_KEY → <home>/.env'
}

async function promptPiOAuthOnly(
  ctx: PromptCtx,
  io: WizardIO,
  provider: 'openai-codex' | 'github-copilot',
  paths: PiPaths,
): Promise<string> {
  const existing = checkPiProviderAuth(paths.authFile, provider)
  if (existing.found && !existing.expired) {
    const exp = existing.expires
      ? ` (expires ${new Date(existing.expires).toISOString().slice(0, 10)})`
      : ''
    write(ctx.out, `\n  Found ${provider} ${existing.type} in ${paths.authFile}${exp}.\n`)
    return `auth.json[${provider}]${exp}`
  }
  if (existing.found && existing.expired) {
    write(
      ctx.out,
      `\n  ⚠️  ${provider} credential found but expired. Re-launching pi for fresh /login.\n`,
    )
  } else {
    write(
      ctx.out,
      `\n  ${provider} requires OAuth — no API key option. Pi will be launched here for /login.\n`,
    )
  }

  // Loop: spawn pi until user gets the credential in place or skips.
  while (true) {
    const result = await spawnPiForLogin(paths, provider, ctx, io)
    if (result.ok) {
      const exp = result.expires
        ? ` (expires ${new Date(result.expires).toISOString().slice(0, 10)})`
        : ''
      return `auth.json[${provider}]${exp}`
    }
    const retry = await askYesNo(ctx, '  Try again?', true)
    if (!retry) {
      write(
        io.stderr,
        `\n  ⚠️  No ${provider} credential set. The server will fail at first turn.\n\n`,
      )
      return '(skipped — none configured)'
    }
  }
}

async function promptPiOtherCredential(
  ctx: PromptCtx,
  envWrites: Record<string, string>,
): Promise<string> {
  write(ctx.out, `\n  Free-form provider — wizard can't auto-detect the env var.\n`)
  write(
    ctx.out,
    `  See Pi's docs for the right name: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md\n`,
  )
  const envVar = (await ctx.rl.question('  Env var name (or empty to skip): ')).trim()
  if (!envVar) return '(skipped — none configured)'
  const value = (await ctx.rl.question(`  Value for ${envVar} (empty to skip): `)).trim()
  if (!value) return '(skipped — none configured)'
  envWrites[envVar] = value
  return `${envVar} → <home>/.env`
}

// ---------------------------------------------------------------------------
// Pi /login subprocess + auth.json detection
// ---------------------------------------------------------------------------

interface SpawnResult {
  ok: boolean
  expired?: boolean
  expires?: number
}

/**
 * Walk up from `startCwd` looking for `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.
 * Returns the absolute path if found, else null.
 */
function walkUpForPiCli(startCwd: string): string | null {
  let cur = path.resolve(startCwd)
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(
      cur,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    )
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

/**
 * Hand the TTY to Pi for an interactive `/login`. Pi inherits stdin/stdout/stderr
 * directly; user types `/login`, completes the browser flow, then `/quit`. On exit
 * we parse the local auth.json to confirm the expected provider key landed.
 *
 * `PI_CODING_AGENT_DIR` routes Pi's writes into `<home>/pi-agent/auth.json`.
 *
 * Launch strategy: walk up `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
 * and spawn `node <cli.js>` directly (cleanest stdio). Fall back to
 * `npx --yes @earendil-works/pi-coding-agent` if not installed.
 *
 * Stdin handoff: our readline puts stdin in flowing mode, intercepting bytes
 * before the child gets them. We close + pause it before spawning, then
 * re-create it after the child exits. Tests inject a mock readline and skip
 * this dance.
 *
 * Limitation: Git Bash / mintty (MSYS2) are not real PTYs — Pi's raw-mode
 * setup will fail. Use Windows Terminal or PowerShell for this step.
 */
async function spawnPiForLogin(
  paths: PiPaths,
  expectedProvider: PiProviderId,
  ctx: PromptCtx,
  io: WizardIO,
): Promise<SpawnResult> {
  write(ctx.out, `\n  Launching pi for OAuth. When it opens:\n`)
  write(ctx.out, `    1. Type  /login  and pick  ${prettyProvider(expectedProvider)}\n`)
  write(ctx.out, `    2. Complete the browser flow\n`)
  write(ctx.out, `    3. Type  /quit  to return here\n`)
  write(ctx.out, `  (first run may take a few seconds; if pi isn't cached yet, npx fetches it)\n`)
  await ctx.rl.question('  Press Enter to continue...')

  // Pick the launch command. Prefer the installed copy for cleaner stdio.
  const piCliPath = walkUpForPiCli(process.cwd())
  const cmd = piCliPath ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = piCliPath ? [piCliPath] : ['--yes', '@earendil-works/pi-coding-agent']

  // Detach our readline so the child gets a clean TTY (no-op in tests with mocked rl).
  const weOwnReadline = !io.readline
  if (weOwnReadline) {
    ctx.rl.close()
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        /* not always supported */
      }
      process.stdin.pause()
    }
  }

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(cmd, args, {
        stdio: 'inherit',
        env: { ...process.env, PI_CODING_AGENT_DIR: paths.agentDir },
        shell: !piCliPath && process.platform === 'win32', // npx needs .cmd resolution on Windows
      })
      child.once('exit', () => resolve())
      child.once('error', (err) => {
        write(
          io.stderr,
          `\n  pi spawn error: ${err.message}\n` +
            `  (need Node.js with npx on PATH — that's bundled with Node, so this should always work)\n`,
        )
        resolve()
      })
    })
  } finally {
    if (weOwnReadline) {
      if (process.stdin.isTTY) {
        // Reset raw mode in case Pi exited abnormally.
        try {
          process.stdin.setRawMode(false)
        } catch {
          /* not always supported */
        }
        process.stdin.resume()
      }
      ctx.rl = createInterface({ input: io.stdin, output: io.stdout })
    }
  }

  const found = checkPiProviderAuth(paths.authFile, expectedProvider)
  if (!found.found) {
    write(
      io.stderr,
      `\n  ⚠️  No credential for "${expectedProvider}" found in ${paths.authFile} after pi exited.\n`,
    )
    return { ok: false }
  }
  if (found.expired) {
    write(
      io.stderr,
      `\n  ⚠️  "${expectedProvider}" credential found but already expired (${new Date(found.expires!).toISOString()}).\n`,
    )
    return {
      ok: false,
      expired: true,
      ...(found.expires !== undefined ? { expires: found.expires } : {}),
    }
  }
  const expStr = found.expires
    ? ` (expires ${new Date(found.expires).toISOString().slice(0, 10)})`
    : ''
  write(ctx.out, `\n  ✓ Detected ${expectedProvider} ${found.type} credential${expStr}.\n`)
  return { ok: true, ...(found.expires !== undefined ? { expires: found.expires } : {}) }
}

interface AuthCheck {
  found: boolean
  type?: 'oauth' | 'api_key'
  expires?: number
  expired?: boolean
}

/**
 * Pure read of `<home>/pi-agent/auth.json` for one provider. Returns
 * `{ found: false }` on missing file, parse failure, or missing provider key —
 * the caller treats all three as "no credential available".
 */
function checkPiProviderAuth(authFile: string, provider: string): AuthCheck {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Record<
      string,
      {
        type?: 'oauth' | 'api_key'
        expires?: number
      }
    >
    const entry = raw[provider]
    if (!entry) return { found: false }
    const out: AuthCheck = {
      found: true,
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
    }
    if (entry.expires !== undefined && entry.expires < Date.now()) {
      out.expired = true
    }
    return out
  } catch {
    return { found: false }
  }
}

function prettyProvider(p: PiProviderId): string {
  switch (p) {
    case 'anthropic':
      return 'Claude Pro/Max (anthropic)'
    case 'openai':
      return 'OpenAI'
    case 'openai-codex':
      return 'ChatGPT Plus/Pro (openai-codex)'
    case 'google':
      return 'Google AI Studio'
    case 'github-copilot':
      return 'GitHub Copilot'
    default:
      return p
  }
}

// ---------------------------------------------------------------------------
// Sub-prompts (existing — Claude credential)
// ---------------------------------------------------------------------------

async function promptAnthropicCredential(
  ctx: PromptCtx,
  io: WizardIO,
): Promise<string | undefined> {
  // Detect existing token
  const layout = homeLayout(io.home)
  const existing =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    readEnvKey(layout.envFile, 'ANTHROPIC_API_KEY') ||
    readEnvKey(layout.envFile, 'CLAUDE_CODE_OAUTH_TOKEN')

  if (existing) {
    const keep = await askYesNo(ctx, 'Found existing Anthropic credential. Keep it?', true)
    if (keep) return undefined // no change
  }

  write(
    ctx.out,
    '  Get a Claude Code OAuth token with `claude setup-token` (from the Claude Code\n' +
      '  CLI; best with a Claude Pro/Max plan), or an API key from console.anthropic.com.\n',
  )
  while (true) {
    const value = (
      await ctx.rl.question(
        '  Anthropic API key (sk-ant-api…) or Claude Code OAuth token (sk-ant-oat…) — paste then Enter, empty = skip: ',
      )
    ).trim()
    if (!value) return undefined // skipped
    write(ctx.out, '  Validating credential...\n')
    const ok = await checkAnthropicCredential(value)
    if (ok.ok) {
      write(ctx.out, '  ✓ Credential works.\n')
      return value
    }
    write(ctx.out, `  ✗ ${ok.error}\n`)
    const retry = await askYesNo(ctx, '  Try again?', true)
    if (!retry) return undefined
  }
}

interface VoiceResult {
  voice: ConfigFile['voice']
  openaiKey?: string
}

async function promptVoiceSetup(
  ctx: PromptCtx,
  io: WizardIO,
  current: ConfigFile['voice'],
): Promise<VoiceResult> {
  const layout = homeLayout(io.home)
  const existingKey = process.env.OPENAI_API_KEY || readEnvKey(layout.envFile, 'OPENAI_API_KEY')

  let openaiKey: string | undefined
  if (existingKey) {
    const keep = await askYesNo(ctx, '  Found existing OPENAI_API_KEY. Keep it?', true)
    if (!keep)
      openaiKey = await askKeyWithValidation(
        ctx,
        '  OpenAI API key (sk-...): ',
        checkOpenAICredential,
      )
  } else {
    openaiKey = await askKeyWithValidation(
      ctx,
      '  OpenAI API key (sk-...): ',
      checkOpenAICredential,
    )
  }

  const sttModel =
    (await ctx.rl.question(`  STT model [${current.sttModel}]: `)).trim() || current.sttModel
  const ttsModel =
    (await ctx.rl.question(`  TTS model [${current.ttsModel}]: `)).trim() || current.ttsModel
  const ttsVoice =
    (await ctx.rl.question(`  TTS voice [${current.ttsVoice}]: `)).trim() || current.ttsVoice

  return { voice: { sttModel, ttsModel, ttsVoice }, openaiKey }
}

async function askKeyWithValidation(
  ctx: PromptCtx,
  prompt: string,
  check: (k: string) => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<string | undefined> {
  while (true) {
    const value = (await ctx.rl.question(prompt)).trim()
    if (!value) return undefined
    write(ctx.out, '  Validating...\n')
    const result = await check(value)
    if (result.ok) {
      write(ctx.out, '  ✓ Validated.\n')
      return value
    }
    write(ctx.out, `  ✗ ${result.error}\n`)
    const retry = await askYesNo(ctx, '  Try again?', true)
    if (!retry) return undefined
  }
}

// ---------------------------------------------------------------------------
// Primitive prompts
// ---------------------------------------------------------------------------

async function askYesNo(ctx: PromptCtx, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const ans = (await ctx.rl.question(`${question} ${hint} `)).trim().toLowerCase()
  if (ans === '') return defaultYes
  return ans === 'y' || ans === 'yes'
}

async function askInt(
  ctx: PromptCtx,
  question: string,
  defaultVal: number,
  min: number,
  max: number,
): Promise<number> {
  while (true) {
    const ans = (await ctx.rl.question(`${question} [${defaultVal}]: `)).trim()
    if (ans === '') return defaultVal
    const n = Number(ans)
    if (Number.isInteger(n) && n >= min && n <= max) return n
    write(ctx.out, `  Please enter an integer between ${min} and ${max}.\n`)
  }
}

// ---------------------------------------------------------------------------
// Per-app config wizard
// ---------------------------------------------------------------------------

export interface PromptAppConfigOptions {
  io: WizardIO
  appId: string
  configSchema?: unknown
  contextSchema?: unknown
}

/**
 * Prompt for each field declared on the app's `config` and `context` schemas.
 * Secret fields route to .env. Empty input keeps the existing value.
 */
export async function promptAppConfigWizard(opts: PromptAppConfigOptions): Promise<void> {
  const { io, appId, configSchema, contextSchema } = opts
  const rl = io.readline ?? createInterface({ input: io.stdin, output: io.stdout })
  const ctx: PromptCtx = { rl, out: io.stdout }

  try {
    write(io.stdout, `\nConfigure "${appId}"\n`)
    write(io.stdout, `  Workspace: ${io.home}\n`)

    let touched = false

    // 1. Config tier (technical setup; secrets route to .env).
    if (isZodSchema(configSchema)) {
      const fields = getObjectFields(configSchema)
      if (fields && Object.keys(fields).length > 0) {
        const current = safeLoadConfig2(io.home, appId, configSchema)
        write(io.stdout, `\nConfig (technical setup):\n`)
        const next = await askFields(ctx, fields, current, true /* allow secret hint */)
        if (next.changed) {
          saveAppConfig({ home: io.home, appId, schema: configSchema }, next.values)
          write(io.stdout, `  Wrote config.json + .env (secret values masked above).\n`)
          touched = true
        } else {
          write(io.stdout, `  No changes.\n`)
        }
      }
    }

    // 2. Context tier (LLM-visible preferences).
    if (isZodSchema(contextSchema)) {
      const fields = getObjectFields(contextSchema)
      if (fields && Object.keys(fields).length > 0) {
        const current = safeLoadAppContext(io.home, appId, contextSchema)
        write(io.stdout, `\nContext (LLM-visible preferences):\n`)
        const next = await askFields(ctx, fields, current, false /* no secrets in context */)
        if (next.changed) {
          saveAppContext({ home: io.home, appId, schema: contextSchema }, next.values)
          write(io.stdout, `  Wrote context.json.\n`)
          touched = true
        } else {
          write(io.stdout, `  No changes.\n`)
        }
      }
    }

    if (!touched) {
      write(
        io.stdout,
        `\nNothing to configure for "${appId}" (no schema declared, or no changes).\n`,
      )
    }
  } finally {
    if (!io.readline) rl.close()
  }
}

interface FieldsResult {
  values: Record<string, unknown>
  changed: boolean
}

async function askFields(
  ctx: PromptCtx,
  fields: Record<string, ZodType>,
  current: Record<string, unknown>,
  hintSecrets: boolean,
): Promise<FieldsResult> {
  const out: Record<string, unknown> = { ...current }
  let changed = false

  for (const [name, fieldSchema] of Object.entries(fields)) {
    const isSecret = hintSecrets && isSecretField(fieldSchema)
    const cur = current[name]
    const display = isSecret
      ? cur === undefined || cur === null || cur === ''
        ? '(unset)'
        : '*****'
      : cur === undefined
        ? '(unset)'
        : JSON.stringify(cur)
    const desc = isSecret
      ? getSecretFieldDescription(fieldSchema)
      : ((fieldSchema as { description?: string }).description ?? '')
    const hint = desc ? ` — ${desc}` : ''
    const ans = (await ctx.rl.question(`  ${name} [${display}]${hint}: `)).trim()
    if (ans === '') continue
    const coerced = coerceFieldInput(ans, fieldSchema)
    out[name] = coerced
    changed = true
  }

  return { values: out, changed }
}

/**
 * Best-effort coercion: try the raw string; if Zod rejects, try number/bool.
 * Returns the raw string on no match — `saveAppConfig`/`saveAppContext`
 * will fail with a clear validation message.
 */
function coerceFieldInput(raw: string, schema: ZodType): unknown {
  const direct = schema.safeParse(raw)
  if (direct.success) return direct.data
  if (raw === 'true') {
    const r = schema.safeParse(true)
    if (r.success) return r.data
  }
  if (raw === 'false') {
    const r = schema.safeParse(false)
    if (r.success) return r.data
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const r = schema.safeParse(Number(raw))
    if (r.success) return r.data
  }
  return raw
}

function safeLoadConfig2(home: string, appId: string, schema: unknown): Record<string, unknown> {
  try {
    return loadAppConfig({ home, appId, schema })
  } catch {
    return {}
  }
}
function safeLoadAppContext(home: string, appId: string, schema: unknown): Record<string, unknown> {
  try {
    return loadAppContext({ home, appId, schema })
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text)
}

function safeLoadConfig(configFile: string): ConfigFile {
  try {
    return loadConfigFile(configFile)
  } catch {
    return ConfigFileSchema.parse({})
  }
}

/**
 * Pick the env var for an Anthropic credential: `CLAUDE_CODE_OAUTH_TOKEN` for
 * `sk-ant-oat...` (OAuth tokens), `ANTHROPIC_API_KEY` for `sk-ant-api...`
 * (console API keys). Misfiling silently breaks auth.
 */
function anthropicEnvVarFor(value: string): 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY' {
  return value.trim().startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
}

/** Look up a key in `<home>/.env` via the canonical parser. */
function readEnvKey(envFile: string, key: string): string | undefined {
  return readEnvFile(envFile)[key]
}

/**
 * Quote a value for safe round-trip through the dotenv parser. Wraps in
 * double quotes when the value contains whitespace, `#`, `'`/`"`, or is empty.
 */
function quoteEnvValue(value: string): string {
  // Escape interior `"` and `\`.
  if (value === '' || /[\s#"']/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `"${escaped}"`
  }
  return value
}

/** Merge new keys into <home>/.env, preserving every other line + comment. */
function mergeEnvFile(envFile: string, additions: Record<string, string>): void {
  let lines: string[] = []
  try {
    lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  } catch {
    /* file missing — start fresh */
  }

  const out: string[] = []
  const written = new Set<string>()

  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (m && m[1] && additions[m[1]] !== undefined) {
      out.push(`${m[1]}=${quoteEnvValue(additions[m[1]]!)}`)
      written.add(m[1])
    } else {
      out.push(line)
    }
  }
  for (const [key, value] of Object.entries(additions)) {
    if (!written.has(key)) out.push(`${key}=${quoteEnvValue(value)}`)
  }
  // Trailing newline + dedup blank-tail
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  fs.writeFileSync(envFile, out.join('\n') + '\n')
}

interface RepoAppsHit {
  repoApps: string
  dirs: string[]
}

/**
 * Walk up from cwd looking for an `apps/` dir whose subdirs have `manifest.{ts,js}`.
 * Returns at most one hit.
 */
function detectRepoApps(): RepoAppsHit[] {
  let cur = process.cwd()
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(cur, 'apps')
    if (looksLikeAppsDir(candidate)) {
      const dirs = fs
        .readdirSync(candidate)
        .map((n) => path.join(candidate, n))
        .filter((d) => looksLikeAppDir(d))
      if (dirs.length > 0) return [{ repoApps: candidate, dirs }]
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return []
}

function looksLikeAppsDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false
    const entries = fs.readdirSync(p)
    return entries.some((n) => looksLikeAppDir(path.join(p, n)))
  } catch {
    return false
  }
}

function looksLikeAppDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false
    return fs.existsSync(path.join(p, 'manifest.ts')) || fs.existsSync(path.join(p, 'manifest.js'))
  } catch {
    return false
  }
}
