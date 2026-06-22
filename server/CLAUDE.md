# server/ — operational rules

## Test boundary

Server tests **must not import from `apps/`**. `apps/` is a separate git submodule; reaching into it couples framework CI to a downstream repo and breaks the framework/plugin layering. Use the synthetic fixture at `server/tests/fixtures/test-app/` for any framework test that needs an `AppDefinition`.

Enforced by `server/scripts/check-test-boundaries.mjs`, run before every `npm test`. The reverse (apps importing from `server/`) is also forbidden — apps depend only on the public `moumantai` SDK.

## Runtime workspace — Moumantai Home

Server runtime config + data live at a single directory we call "Moumantai Home". Default `~/.moumantai/`; the wizard offers checkout-local + custom paths and stamps a per-OS pointer file so the choice survives any cwd / cron / systemd context.

**Resolution precedence (first hit wins)** — `server/src/server/workspace/home.ts:resolveMoumantaiHome`:

1. `MOUMANTAI_HOME` env var — explicit override (tests, packaging, debugging)
2. Walk up from cwd for `<ancestor>/.moumantai/` — "I'm in THIS checkout right now". Stops at `$HOME` so it never falsely hits `~/.moumantai`
3. Pointer file (one absolute path inside) — wizard's persistent choice, per-OS location:
   - Linux/BSD/WSL: `${XDG_CONFIG_HOME:-~/.config}/moumantai/home`
   - macOS: `~/Library/Application Support/moumantai/home`
   - Windows: `%APPDATA%\moumantai\home`
4. Default `~/.moumantai/`

The walker beats the pointer so cd-ing into a different checkout works on its workspace, not your daily-use one. The pointer beats the default so launchd/cron/systemd find the wizard's choice without a shell env var.

**Inspecting + changing the resolved home**: `task server:cli -- workspace path` prints the resolved home + which precedence step picked it; `workspace set <path>` writes the pointer; `workspace reset` deletes it.

```
~/.moumantai/
├── config.json       # tunables (port, backend, voice, hotReload, pi, …) — Zod-validated
├── .env              # secrets only (ANTHROPIC_API_KEY, OPENAI_API_KEY)
├── platform.db       # chat history + SDK session bindings (incl. sdk_backend)
├── apps-src/<id>/    # installed plugin source (symlinks to repo/apps/* in dev)
├── apps/<id>/        # per-app runtime state
│   ├── db.sqlite     # per-app Drizzle DB
│   └── cwd/          # synthetic SDK working dir
├── apps/home/cwd/    # synthetic SDK cwd for the `home` app
├── apps-drafts/<draftId>/  # coding-agent draft worktrees (dev mode only): app
│   │                       #   source + .shadow/db.sqlite + .meta.json + .claude/
│   └── …
├── pi-agent/         # Pi backend's agentDir (only when backend=pi)
│   └── auth.json     # OAuth tokens + runtime API keys (chmod 600)
└── pi-sessions/      # Pi session jsonl, one subdir per conversation
    └── <conv-id>/
        └── <id>.jsonl
```

**App-source resolution**: `MOUMANTAI_APP_DIRS` env > `<home>/apps-src/` (populated by `app install`) > `<repo>/apps/` (resolved against `process.cwd()`). The last fallback lets dev runs from a checkout work without `init`.

**Config precedence**: `MOUMANTAI_*` env > `<home>/config.json` > schema defaults. Secrets live ONLY in `.env`.

## LLM backends

`config.backend` picks the active adapter:

- `claude` (default) — `@anthropic-ai/claude-agent-sdk`. Auth: `CLAUDE_CODE_OAUTH_TOKEN` (primary) or `ANTHROPIC_API_KEY` (fallback).
- `pi` — `@earendil-works/pi-coding-agent`. Multi-provider front-end (Anthropic, OpenAI, Google, Bedrock, Cloudflare, Xiaomi MiMo, ~26 providers; 3 OAuth-subscription providers: Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot). Pick provider + model via `config.pi.provider` + `config.pi.model` or `MOUMANTAI_PI_PROVIDER` / `MOUMANTAI_PI_MODEL` env. Auth precedence: `apiKey` (set programmatically) → `<home>/pi-agent/auth.json` → provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).

**OAuth subscription (Pi only)**: there is **no** `pi login` subcommand. Either let `task server:cli -- init` launch `pi` in-place (the wizard takes over the TTY, you type `/login`, then `/quit` to return), or run `pi` yourself with `PI_CODING_AGENT_DIR=<home>/pi-agent npx @earendil-works/pi-coding-agent`. Refresh tokens work in-process thereafter.

⚠️ **Git Bash / mintty caveat (Windows)**: Pi's TUI uses raw-mode stdin and the alt-screen buffer, which require a real PTY. Git Bash and other MSYS2-based shells expose a pipe instead, and Pi's interactive REPL will appear frozen or refuse to render. For the wizard's `/login` step (or any direct `pi` invocation), use **Windows Terminal, PowerShell, or cmd.exe** instead. WSL terminals work fine.

**Image attachments** are not supported on the Pi backend — the adapter emits an `error` event instead of silently dropping. Use `claude` if you need image input.

⚠️ **Pi adapter event model**: Pi emits `turn_end` after EVERY assistant message in the loop (including ones that contain tool_use). Only `agent_end` is terminal. Treat the two events separately in `pi/adapter.ts:mapEvent` — conflating them silently truncates tool-calling conversations to empty replies. Session resume uses `SessionManager.continueRecent(cwd, sessionDir)`: the conversation→session mapping is implicit via `<home>/pi-sessions/<conversationId>/`, NOT via the `sdk_session_id` UUID.

### `conversations.sdk_backend` and switching backends

Each conversation row tracks both `sdk_session_id` (the SDK's jsonl id) and `sdk_backend` (which SDK produced it). Sessions are **not portable across backends**: a Claude session id is meaningless to Pi and vice-versa. When `config.backend` changes, the read-side `sdkBound` check picks up the mismatch, the adapter mints a fresh session, and `bindSdkSession`'s case 4 overwrites both columns. UI chat history is preserved across backend switches; LLM in-context memory is not (neither adapter currently replays `ConversationStore` on first turn).

## CLI surface

Run as `task server:cli -- <subcommand>` or `tsx src/server/cli.ts` directly.

| Command | What |
|---|---|
| `init` | Interactive setup wizard (`--non-interactive` for defaults). **The only entry to the wizard** — covers first run *and* reconfigure |
| `config` / `config show` / `config edit` | Print resolved config with origins (bare `config` = `show`) / same / open in `$EDITOR`. Read/edit only — not the wizard. For `<home>` use `workspace path` |
| `workspace path` / `set <path>` / `reset` | Print resolved `<home>` + source (env/walker/pointer/default) / stamp the pointer / delete it |
| `app install <path\|url\|id>` | Install from local path, git URL (`<url>#<ref>:<subdir>`), or bare id (resolved across registries). `--from <url>` for one-shot registry resolve |
| `app update [<id>]` | Re-fetch git origins; no-op for local installs |
| `app uninstall <id>` | Remove from `apps-src` + meta file; prompts before deleting per-app DB + cwd |
| `app list [--from <url>]` | List installed apps or browse a registry catalog |
| `app search <query>` | Substring-match id + description across configured registries |
| `app cache-clear <id> [--yes]` | Wipe an app's asset cache; next refresh repopulates |
| `registry add <name> <url>` / `list` / `remove <name>` / `update [<name>]` | Manage `config.json:appRegistries` and the git cache |

Install origin written to `<home>/apps-meta/<id>.json`: `{type: 'local', source, linkType}` for path installs; `{type: 'git', url, ref, subdir?, commit}` for git installs. `app update` refreshes only git origins.

## Hot-reload cache-bust limitation

`reloadAppModule` busts the entry URL with `?v=<t>`; `scanSupplemental*` and `evalTsFile` use `?t=<t>` for LLM-generated files. **Cache-bust does NOT propagate to transitive imports.** Editing `parts.ts`, `face.resolve.ts`, `schema.ts`, `lib/*.ts` does NOT auto-reload — touch the app's `index.ts` to force entry reload, or restart the server. A previous loader-hook approach leaked unbounded module records (Node ESM cache has no public eviction API).
