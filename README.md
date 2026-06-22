<p align="center">
  <img src="clients/pwa/public/icons/icon-512.png" alt="Moumantai logo" width="120">
</p>

# Moumantai

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/xiang-deng/moumantai)

**Moumantai** (冇問題 / no problem) is an open-source, self-hosted runtime for personal apps that can be owned, adapted, and used across the devices around you.

Describe an app once: its data, capabilities, and interfaces. The server holds the state and application logic, then projects the appropriate face onto the browser, phone, watch, or embedded display in front of you. Code defines the reliable behavior; an LLM-powered agent adds language, interpretation, and judgment within those boundaries.

The result is an app, not a prompt: durable software that can be reused, inspected, shared, and remixed.

You drive; the agent helps.

[Quick start](#quick-start) · [Architecture](#architecture) · [Plugin apps](#plugin-apps) · [Agent backends](#agent-backends) · [Clients](#clients) · [Develop](#develop)

<p align="center">
  <img src="docs/demo.gif" alt="Moumantai demo: a chat-driven home agent and mini apps rendering natively on a phone and a watch" width="820"><br>
  <sub><i>Talk to one agent; your mini apps render natively on every screen.</i></sub>
</p>

## Key features

- **Yours, end to end** — self-host the runtime and own the app's source, data, behavior, appearance, and deployment.
- **Schema. Tools. Faces.** — a deliberately familiar CRUD core: the schema owns state, tools mutate, and faces read. Direct UI and agent calls meet at the same tool boundary.
- **Code for the known, an agent for the fuzzy** — taps and forms stay deterministic; an LLM-powered agent brings language, flexibility, and judgment when useful.
- **Bring your own agent and model** — the agent supplies orchestration and tool use; the model supplies inference. Choose the combination that fits the task, provider, and budget.
- **Polyphenic apps, native surfaces** — one app wears many faces, specialized for each device and context. Thin clients map the same typed protocol to the toolkit that fits — from browsers and phones to watches and embedded panels — while the server carries the heavy compute.
- **Apps, not prompts** — code and interfaces are reused rather than regenerated on every request, saving tokens and making smaller or less expensive models practical. The result can be inspected, shared, forked, and personalized.
- **Build, preview, promote** — a coding agent can draft or edit an app in isolation, validate it, and preview it on paired devices; nothing goes live until you choose to promote it.

Moumantai is early and evolving; expect rough edges and changing APIs. Trying it, reporting what breaks, and contributing improvements are all welcome.

## Quick start

Runs the **server + PWA** locally — the fastest path to a working app. Native clients are opt-in (see [Running on your devices](#running-on-your-devices)).

**1. Set up.** Clone with the plugin-apps submodule:

```bash
git clone --recurse-submodules https://github.com/xiang-deng/moumantai.git
cd moumantai
# Already cloned without --recurse-submodules? Run: git submodule update --init
```

Then install the toolchain — [install mise](https://mise.jdx.dev/getting-started) (`winget install jdx.mise` · `brew install mise` · `curl https://mise.run | sh`), activate it in your shell (`mise activate pwsh|bash|zsh`), open a fresh shell, and run:

```bash
mise install && uv sync   # Node 22, Python 3.12, JDK 17, task, buf, uv
npm install               # links the TS workspaces (server, pwa, protocol)
```

**2. Configure the server.** An interactive wizard sets up the workspace (**Moumantai Home** — config, secrets, per-app data) and your LLM credential. Its first prompt asks **where** the workspace lives (default `~/.moumantai/`; see [Where your data lives](#where-your-data-lives)):

```bash
task server:init
```

By default the wizard expects a **Claude** credential — one of:

| Credential | Format | Where to get it |
|---|---|---|
| OAuth token | `sk-ant-oat…` | `claude setup-token` (from the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)); best with a Claude Pro/Max plan |
| API key | `sk-ant-api…` | [console.anthropic.com](https://console.anthropic.com) |

Prefer another agent harness, model, or provider? See [Agent backends](#agent-backends).

**3. Start the server and the PWA** in two terminals:

```bash
task server:dev   # Terminal A — WebSocket on ws://localhost:3000
task pwa:dev      # Terminal B — Vite on http://localhost:5174
```

**4. Pair this browser.** Pairing is **on by default** — the server only accepts allowlisted devices. Open an enrollment window:

```bash
task server:cli -- device pair   # opens a 5-minute enrollment window
```

Open **http://localhost:5174**; the PWA shows a pairing code. Back in the `device pair` prompt, type `approve <code>` — the browser connects within seconds. (Local-only? Disable with `pairingRequired: false` via `task server:cli -- config edit`, but keep it on for any networked server.)

**5. Try it.** In chat, type:

```
add 5 dollars for coffee
```

The **spend-tracker** plugin app picks it up via the agent, runs its `add_expense` tool, and re-renders the Summary face. Swipe up/down to switch faces within an app, left/right to switch apps.

> [!NOTE]
> The server is a WebSocket endpoint — opening `http://localhost:3000` in a browser shows nothing; the PWA (or a native app) is the consumer. Change the port with `task server:init`.

**6. Make it your own.** The bundled spend-tracker shows the idea. From here you can:

- **Install an existing app** — from a local path, a git URL, or a registry id:

  ```bash
  task server:cli -- app install <path|url|id>
  task server:cli -- app list
  ```

- **Edit one directly** — work in TypeScript using the same schema, tool, face, and validation rules used by the coding agent.
- **Use the coding agent** — describe an app or change in the PWA's dev tab, preview its isolated draft, then promote it when ready.

Both are covered in full under [Plugin apps](#plugin-apps).

## Where your data lives

The server keeps all runtime state in one directory — **Moumantai Home**: `config.json`, secrets in `.env`, chat history, and each app's SQLite database. The setup wizard's first prompt picks where it goes:

- **`~/.moumantai/`** — the default; best for everyday use.
- **`<checkout>/.moumantai/`** — project-local and gitignored; best for development and keeping multiple checkouts / worktrees isolated.

Not sure which home is active (common with multiple clones)? `task server:cli -- workspace path` prints it **and which rule selected it**. The full resolution order and the `workspace set`/`reset` commands live in [`server/CLAUDE.md`](./server/CLAUDE.md).

Credentials are stored on the server and never sent to clients or plugin apps. The active agent backend uses them to authenticate with the provider you configure; prompts and relevant app context may be sent to that provider.

> [!IMPORTANT]
> **No standalone binary.** There's no `moumantai` command to install — admin commands run from the checkout as `task server:cli -- <command>` (e.g. `task server:cli -- device list`). `task server:init` is the single setup wizard (first run *and* reconfigure); `task server:cli -- config show` / `config edit` inspect and hand-edit the saved config.

## Architecture

Moumantai is a server-authoritative application runtime. The server owns state, execution, and coordination; plugin apps, agent backends, and clients connect through explicit contracts.

| Component | Responsibility | Architectural boundary |
|---|---|---|
| **Server runtime** | Owns application state, capability execution, agent orchestration, device coordination, and presentation resolution | The authoritative core: state changes and business execution happen here |
| **Plugin app** | Defines data, capabilities, and presentation through schemas, tools, and faces | Uses the app SDK; independent of clients and agent backends |
| **Agent backend** | Connects an agent harness and its model to app context, tools, and faces | May request actions or steer presentation; never mutates app state directly |
| **Shared protocol** | Defines transport messages, the UI-component vocabulary, and generated TypeScript, Kotlin, and C types | The stable contract between the server and client implementations |
| **Client** | Renders protocol components with its platform toolkit and reports user intent | Owns device interaction and rendering, not app data, business behavior, or model credentials |

The design follows a few strict boundaries:

- **Tools mutate; faces read; parameters steer presentation.**
- **The server is authoritative; clients render and report intent.**
- **Agent backends request actions; the server validates and executes them.**
- **Device specialization happens on the server, outside plugin business logic.**
- **Apps do not depend on a particular client, agent harness, or model.**

Implementation detail lives with each boundary: the [server](./server/README.md), [app examples](./apps/README.md), [protocol](./shared/protocol/spec.md), and [client READMEs](#clients).

## Plugin apps

An app is a small TypeScript plugin: a Drizzle schema, `defineTool` tools, and `defineFace` faces. Example apps ship in the [`apps/`](./apps/README.md) submodule and serve as working references.

### Install or remix an existing app

Install from a local path, git URL, or registry id; installed source remains available to inspect and change:

```bash
task server:cli -- app install <path|url|id>
task server:cli -- app list
```

### Edit directly

Write or modify the TypeScript yourself. Humans and coding agents follow the same rules in [`CLAUDE.md`](./CLAUDE.md) and the [`build-moumantai-app`](./.claude/skills/build-moumantai-app/) / [`edit-moumantai-app`](./.claude/skills/edit-moumantai-app/) skills. Validate app changes with `task apps:typecheck`.

### Use the coding agent

Enable dev mode (`MOUMANTAI_DEV_MODE=1`, or `devMode: true` in `.moumantai/config.json`) and describe an app or change in the PWA's dev tab. The agent works through an isolated draft: **draft → validate → preview → promote or discard**. Nothing touches the live app until you choose to promote it.

Dev mode is off by default; restart the server after enabling it.

## Agent backends

The server integrates intelligence through an agent backend contract. A backend connects its agent harness and chosen model to app context, tools, and faces; the server keeps ownership of tool execution and state.

| Backend | Agent harness | Models / providers | Authentication |
|---|---|---|---|
| `claude` (default) | Claude Agent SDK | Anthropic Claude | OAuth token or Anthropic API key (see [Quick start](#quick-start)) |
| `pi` | Pi Coding Agent | More than two dozen providers, including Anthropic, OpenAI, Google, and Bedrock | Provider API key or OAuth |

Select the backend in `.moumantai/config.json`. Provider/model selection and authentication details are covered in [`server/CLAUDE.md`](./server/CLAUDE.md#llm-backends).

## Clients

Clients are independent implementations of the shared protocol. Each maps the same component vocabulary to the toolkit and interaction model that fits its platform.

| Client | Role | Stack | Run |
|---|---|---|---|
| **PWA** | Universal browser and installable client; the quickest way to start | React + Vite | `task pwa:dev` (or a [production mode](#running-on-your-devices)) |
| **Wear OS** | Glanceable interaction on a watch | Kotlin + Wear Compose | `task wear-os:install` |
| **Embedded panel** | Ambient, always-on display on a wall or desk | ESP-IDF + LVGL (C) | `task esp32:build && task esp32:flash` |
| **Android phone** | Native phone client and path to device capabilities | Kotlin + Compose M3 | `task android:install` |

Per-client setup lives in each client's README: [PWA](./clients/pwa/README.md) · [Android](./clients/android/README.md) · [Wear OS](./clients/wear-os/README.md) · [ESP32](./clients/esp32/README.md).

## Running on your devices

The PWA has three deliberately different modes:

| Mode | Command | Use |
|---|---|---|
| Local development | `task pwa:dev` | Vite on `http://localhost:5174`; no service worker and not installable |
| Local production | `task pwa:serve` | Production bundle on `http://localhost:4173`; installable on the host because `localhost` is a secure context |
| Secure remote | `task pwa:serve:tailscale TAILSCALE_HOST=<host>.<tailnet>.ts.net` | Production bundle for a phone or another tailnet device over HTTPS/WSS |

For secure remote access, start the server and PWA in separate terminals, then expose each loopback service through Tailscale Serve:

```bash
task server:dev
task pwa:serve:tailscale TAILSCALE_HOST=<host>.<tailnet>.ts.net

tailscale serve --bg --https=443 http://localhost:4173
tailscale serve --bg --https=8443 http://localhost:3000
```

Open `https://<host>.<tailnet>.ts.net`. The PWA connects to `wss://<host>.<tailnet>.ts.net:8443`; both endpoints remain inside the tailnet with TLS. A plain `http://<host>:<port>` URL may be reachable but is not an installable secure context.

Native clients are opt-in, and each connects to the same server and must be **paired** the same way — `task server:cli -- device pair`, then `approve` the code shown on the device (see [Quick start](#quick-start)).

<details>
<summary><b>Native client setup (Android, Wear OS, ESP32)</b></summary>

First copy the per-machine config template once — it is gitignored and merged on top of the pinned `.mise.toml`:

```bash
cp .mise.local.toml.example .mise.local.toml
```

Then fill in the variables for each client you want to build:

| Client | Prerequisite | Set in `.mise.local.toml` | Build & deploy |
|---|---|---|---|
| Android phone | Android Studio (or `sdkmanager`) | `ANDROID_HOME` | `task android:install` (ADB to a connected device/emulator) |
| Wear OS watch | Android Studio + a Wear AVD | `ANDROID_HOME` | `task wear-os:install` |
| ESP32 panel | ESP-IDF v5.4+ | `IDF_PATH`, `PORT` (e.g. `COM3` / `/dev/ttyUSB0`) | `task esp32:build && task esp32:flash` (override inline: `task esp32:flash PORT=COM4`) |

See per-client setup in [`clients/android/README.md`](./clients/android/README.md), [`clients/wear-os/README.md`](./clients/wear-os/README.md), and [`clients/esp32/README.md`](./clients/esp32/README.md).

</details>

## Develop

Every workspace exposes its commands through [Task](https://taskfile.dev/). Use `task --list-all` for the complete, current inventory.

### Run and verify

| Command | What it does |
|---|---|
| `task server:dev` | Server in watch mode (hot-reloads on source changes) |
| `task pwa:dev` | PWA dev server (Vite) |
| `task server:test` | Server boundaries, typecheck, unit tests, and integration tests |
| `task pwa:test` | PWA typecheck and unit tests |
| `task apps:typecheck` | Example/plugin apps against the current SDK |
| `task test-form-semantics` | Cross-client form-to-tool contract |
| `task test-layout-resolution` | Cross-renderer layout conformance |
| `task format:check` | Formatting across TypeScript, Python, C, proto, Android, and Wear |

### Regenerate shared outputs

| Source changed | Regenerate | Check for drift |
|---|---|---|
| Protocol `.proto` files | `task protocol:gen` | `task protocol:gen-check` |
| Design-system catalog | `task design-system:gen` | `task design-system:gen-check` |
| `shared/tokens/*.yaml` | `task tokens` | `task lint:tokens` |
| `branding/icon.source.png` | `task icons` | Review generated client assets |
| Client Taskfiles | `task registry` | `task registry-check` |

Start with [`CLAUDE.md`](./CLAUDE.md) — codebase rules and dev workflow. Subsystem-specific rules live in `<dir>/CLAUDE.md` files (auto-loaded by Claude when working in that subtree). One gotcha worth knowing up front: hot-reload does not propagate to transitive imports — touch an app's `index.ts` or restart the server after editing its `parts.ts` / `schema.ts` (details in [`server/CLAUDE.md`](./server/CLAUDE.md)).

### Repository layout

```
moumantai/
├── server/             # Node WebSocket server + agent + protocol handling
├── clients/
│   ├── pwa/            # Progressive Web App client (React + Vite)
│   ├── android/        # Phone client (Kotlin + Compose M3)
│   ├── wear-os/        # Watch client (Kotlin + Wear Compose)
│   └── esp32/          # HMI panel firmware (ESP-IDF + LVGL)
├── shared/
│   ├── protocol/       # Wire protocol SSOT (.proto + generated TS/Kotlin/C bindings)
│   └── tokens/         # Design tokens (YAML, codegen targets each client)
├── apps/               # Plugin apps (submodule of moumantai-apps; loaded at runtime)
├── scripts/            # Codegen + dev helpers
└── docs/               # Architecture / design docs
```

The TypeScript pieces (`server/`, `clients/pwa/`, `shared/protocol/`) are npm workspaces. Native clients (`clients/android`, `clients/wear-os`, `clients/esp32`) are independent — each uses its own native build tool.

## Troubleshooting

<details>
<summary>Common setup issues and fixes</summary>

| Symptom | Fix |
|---|---|
| `task` / `uv` / `node` not found after install | You missed `mise activate` — add the printed line to your shell rc and open a fresh shell. |
| PWA will not connect / "pairing required" | Open an enrollment window (`task server:cli -- device pair`) and `approve` the code, or disable pairing for local dev with `task server:cli -- config edit`. |
| `task server:dev` fails with credential errors | Re-run `task server:init`, or `task server:cli -- config show` to see what is loaded. |
| Port 3000 or 5174 already in use | Change the port via `task server:init`, then `VITE_WS_URL=ws://localhost:<port> task pwa:dev`. |
| Chat does nothing / tool not called | Check the server log (Terminal A) — the prompt likely matched no tool. Try a more direct phrasing, or list loaded apps with `task server:cli -- app list`. |
| Plugin app did not appear | The submodule may be empty — run `git submodule update --init` and restart the server. |
| Server using unexpected config / workspace | `task server:cli -- workspace path` shows the active Moumantai Home and which rule selected it; override with `MOUMANTAI_HOME=<path>` or `task server:cli -- workspace set <path>`. |

</details>

## Documentation

| I want to… | Start here |
|---|---|
| Follow the codebase workflow | [`CLAUDE.md`](./CLAUDE.md) |
| Build or edit a plugin app | [`build-moumantai-app`](./.claude/skills/build-moumantai-app/) · [`edit-moumantai-app`](./.claude/skills/edit-moumantai-app/) · [examples](./apps/README.md) |
| Work on the server or agent backends | [`server/README.md`](./server/README.md) · [`server/CLAUDE.md`](./server/CLAUDE.md) |
| Change the wire protocol | [`shared/protocol/spec.md`](./shared/protocol/spec.md) |
| Author or render UI components | [authoring reference](./shared/protocol/design-system/authoring.md) · [renderer reference](./shared/protocol/design-system/rendering.md) |
| Set up a client | [PWA](./clients/pwa/README.md) · [Android](./clients/android/README.md) · [Wear OS](./clients/wear-os/README.md) · [ESP32](./clients/esp32/README.md) |

## Contributing

Contributions are welcome — including via coding agents. Start with [`CLAUDE.md`](./CLAUDE.md) (codebase rules and dev workflow), use the issue and PR templates under [`.github/`](./.github/), and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please report it privately — see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE)
