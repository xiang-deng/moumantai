# workspace — Module Spec

## Purpose

Manages the **Moumantai Home** — the single directory that owns server runtime config (config.json + .env) and runtime data (platform.db, per-app DBs, synthetic SDK cwds, installed plugin app source). This module is the boundary between OS conventions and the rest of the server.

## Public API

| Symbol | Where | One-liner |
|---|---|---|
| `resolveMoumantaiHome({cwd?, env?})` | `home.ts` | Resolve home (first hit wins): env var > ancestor `.moumantai/` walk from cwd (stops at `$HOME`) > per-OS pointer file > `~/.moumantai/`. |
| `ensureHomeLayout(home)` | `home.ts` | Idempotent mkdir of all standard subdirs. Returns layout. |
| `homeLayout(home)` | `home.ts` | Pure path-derivation: `{home, configFile, envFile, platformDb, appsSrcDir, appsDir, appsMetaDir, appsDraftsDir, homeAppCwd, cacheDir, gitCacheDir}`. |
| `appPaths(home, appId)` | `home.ts` | Pure path-derivation: `{root, dbFile, cwd}` for a per-app slot. |
| `readEnvFile(path)` | `dotenv.ts` | Tiny `.env` parser; returns `{}` on ENOENT. |
| `applyToProcessEnv(map, target?)` | `dotenv.ts` | Inject env-map into target without overwriting existing keys. |
| `loadConfigFile(path)` | `config-loader.ts` | Read+validate `<home>/config.json`; write defaults on first run. Throws with readable error on schema violation. |
| `writeConfigFile(path, config)` | `config-loader.ts` | Atomic pretty-printed write. |
| `mergeEnvOverrides(home, file, env?)` | `config-loader.ts` | Apply MOUMANTAI_* env overrides → flat ServerConfig + origin map. |
| `loadServerConfig(home, configPath, env?)` | `config-loader.ts` | One-call convenience: file + env merge. |
| `parseInstallSource(spec)` | `apps-installer.ts` | Parse `<path>` or `<git-url>[#<ref>[:<subdir>]]` into a tagged `InstallSource`. |
| `installApp(home, spec)` | `apps-installer.ts` | Install from local path (symlink/junction; copy on EPERM) or git URL (cache-clone + worktree-checkout). Writes `<home>/apps-meta/<id>.json`. Validates SemVer + `moumantaiMinVersion` compat. |
| `updateApp(home, id)` | `apps-installer.ts` | Re-fetch git origin if commit changed; no-op for local installs. Returns `{updated, fromVersion?, toVersion?, fromCommit?, toCommit?, reason?}`. |
| `uninstallApp(home, appId)` | `apps-installer.ts` | Remove `apps-src/<id>/` + meta; report whether runtime data still exists (caller decides). |
| `deleteAppRuntimeState(home, appId)` | `apps-installer.ts` | Caller-confirmed delete of `<home>/apps/<id>/`. |
| `listInstalled(home)` | `apps-installer.ts` | Enumerate `apps-src/`. Reads meta when present; falls back to fs-derived info for legacy installs. |
| `extractManifest(dir, {requireVersion?})` | `apps-installer.ts` | Regex-extract `id`/`version`/`moumantaiMinVersion` from `manifest.{ts,js}`. Throws on missing version when `requireVersion`. |
| `ensureGitClone(url, gitCacheDir)` | `git.ts` | Maintains a `--mirror` clone at `<gitCacheDir>/<sha1(url)>/`; runs `git fetch --prune` on subsequent calls. |
| `resolveCommit(cacheDir, ref)` | `git.ts` | Resolve a branch/tag/sha to a 40-char commit. Throws `GitError(BAD_REF)`. |
| `materializeWorktree(cacheDir, commit)` | `git.ts` | `git worktree add --detach` to a tempdir; caller MUST call `.cleanup()`. |
| `fetchRegistry(home, url)` | `registry.ts` | Read+validate `registry.json` from a git URL (cache-clone @ HEAD) or a local directory. |
| `resolveAppFromRegistry(reg, id)` | `registry.ts` | Look up an entry → `InstallSource` ready for `installApp`. Default repo URL = registry's URL; entries can override via `repo:` / `ref:`. |
| `appRegistries` config field | `config-loader.ts` | Persisted list of `{name, url}` pairs (`task server:cli -- registry add/list/remove/update`); referenced by `app install <id>` and `app search` for cross-registry resolution. |
| `runWizard({home, stdout, stderr, stdin, readline?})` | `wizard.ts` | Interactive setup. Pure async I/O — testable with a mock readline. |
| `checkAnthropicCredential(token)` | `credential-check.ts` | Validate via `GET /v1/models`. Always resolves (never throws). |
| `checkOpenAICredential(token)` | `credential-check.ts` | Validate via OpenAI `/v1/models`. Always resolves. |

## Dependencies

- `node:fs`, `node:path`, `node:os` (built-in)
- `node:readline/promises` (wizard)
- `zod` (config schema; already a server dep)
- The rest of the server depends on this module via `config.ts`, `db/platform-db.ts`, `agent/{app-engine,delegation,app-loader}.ts`.

## Constraints

- **Cross-platform**: `~/.moumantai/` works on Linux, macOS, Windows (`%USERPROFILE%\.moumantai\`), and WSL identically. We deliberately do NOT use OS-native dirs (`%LOCALAPPDATA%`, `~/Library/Application Support`, `~/.local/share`) — single-dir ergonomics > XDG correctness for this single-user CLI/server.
- **Read/write needs**: every subpath under `<home>` must be RW for the current user. `<home>` itself is mkdir'd at boot. `.env` is `chmod 0600` on Unix.
- **No roaming `%APPDATA%`**: SQLite over a synced profile risks corruption — explicit non-goal.
- **Secrets isolation**: API keys never appear in `config.json`, only in `<home>/.env`. The wizard enforces this. `config show` redacts secret values.
- **`MOUMANTAI_HOME` is bootstrap-only**: must be set in process env / shell, NOT in `<home>/.env` (chicken/egg — we need it to find `.env` itself).
- **Symlinks on Windows**: use `'junction'` link type so non-admin users can link without Developer Mode. Fall back to copy on EPERM with a clear warning that source-edits won't propagate.

## Example (happy path)

```ts
import { resolveMoumantaiHome, ensureHomeLayout, homeLayout } from './home.js'
import { readEnvFile, applyToProcessEnv } from './dotenv.js'
import { loadServerConfig } from './config-loader.js'

const home = resolveMoumantaiHome()
const layout = ensureHomeLayout(home)
applyToProcessEnv(readEnvFile(layout.envFile))
const config = loadServerConfig(home, layout.configFile)
// → { home, port: 3000, backend: 'claude', appDirs: ['../apps' or <home>/apps-src], ... }
```

## Layout reference

```
<home>/
├── config.json           # Zod-validated; on-disk shape is nested
├── .env                  # secrets only
├── platform.db           # chat history + SDK session bindings
├── apps-src/<id>/        # installed plugin source (symlink/junction, copy, or git-materialized snapshot)
├── apps-meta/<id>.json   # per-install metadata (origin, version, commit, installedAt)
├── apps/<id>/
│   ├── db.sqlite         # per-app Drizzle DB
│   └── cwd/              # synthetic SDK working dir
├── apps/home/cwd/        # 'home' app's SDK cwd
└── cache/git/<hash>/     # bare/mirror clones for git-installed apps (safe to delete)
```

## Install origin types (`<home>/apps-meta/<id>.json`)

```jsonc
// local install
{ "id": "...", "version": "0.1.0",
  "origin": { "type": "local", "source": "/abs/path", "linkType": "link" },
  "installedAt": "2026-04-29T..." }

// git install
{ "id": "...", "version": "0.1.0",
  "origin": { "type": "git", "url": "https://...", "ref": "v0.2.0",
              "subdir": "apps/foo", "commit": "abc123..." },
  "installedAt": "2026-04-29T..." }
```

`apps-meta/` is OUTSIDE `apps-src/` so we can write meta even when `apps-src/<id>/` is a symlink we don't own (or a copy that gets wiped on update).

Manifest contract requires `version: string` (SemVer). `moumantaiMinVersion?: string` is checked against `server/package.json` version at install time — mismatch → install fails with actionable error.

## Registry contract (`registry.json` at the root of a registry repo)

```jsonc
{
  "name": "moumantai-examples",      // registry name (required, non-empty)
  "version": "1",                 // schema version (currently "1")
  "apps": [
    {
      "id": "spend-tracker",
      "version": "0.1.0",
      "subdir": "spend-tracker",          // optional; default = repo root
      "description": "Track daily expenses",
      "repo": "...",                       // optional: override repo URL
      "ref": "v0.2.0",                     // optional: override default HEAD
      "moumantaiMinVersion": "0.1.0"          // optional: engine compat hint
    }
  ]
}
```

A "registry" can be a git repo (cloned via `git.ts` cache) or a local directory containing `registry.json`. CLI: `task server:cli -- app list --from <url>` browses; `task server:cli -- app install <id> --from <url>` resolves via the registry then installs through the standard git-source path.

## Configured registries

Registries can be persisted in `<home>/config.json` for one-time setup + zero-friction discovery:

```bash
task server:cli -- registry add examples https://github.com/xiang-deng/moumantai-apps
task server:cli -- registry list
task server:cli -- registry update [<name>]   # refresh the git cache for one or all
task server:cli -- registry remove <name>

task server:cli -- app install <id>           # resolves across all configured registries
                                  # ambiguity → lists matches + suggests --from
task server:cli -- app search <query>         # substring match on id + description
```

The CLI persists `[{name, url}]` to `config.json:appRegistries`. `app install <id>` (without `--from`) detects bare ids (lowercase kebab-case, no path/scheme) and routes through `installFromConfiguredRegistries` (inline in `cli.ts`). Multiple registries with the same id → error listing alternatives.
