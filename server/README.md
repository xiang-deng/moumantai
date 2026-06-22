# Moumantai server

The TypeScript WebSocket server — runs plugin apps, coordinates agent backends,
and speaks the Moumantai wire protocol to every client (PWA, Android, Wear OS,
ESP32). See the
[root README](../README.md) for project overview and one-time toolchain setup.

For runtime internals — "Moumantai Home" (`~/.moumantai/`) layout, config
precedence, LLM backends, the full CLI surface, and the hot-reload gotcha — read
[`CLAUDE.md`](./CLAUDE.md).

## First run

```bash
task server:init
```

An interactive wizard that creates the runtime workspace ("Moumantai Home" —
`~/.moumantai/` by default, or a project-local `.moumantai/`) and prompts for
your LLM credential. It writes secrets to `<home>/.env` and tunables to
`<home>/config.json`. Re-run anytime with `task server:init`; inspect or
hand-edit with `task server:cli -- config show` / `task server:cli -- config edit`.

### Credential — you need one of

- **OAuth token** (`sk-ant-oat…`) — best with a Claude Pro/Max subscription.
  Generate it with `claude setup-token` (from the
  [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)) and paste it
  into the wizard.
- **API key** (`sk-ant-api…`) — from
  [console.anthropic.com](https://console.anthropic.com).

(The optional `pi` backend supports more providers; see [`CLAUDE.md`](./CLAUDE.md#llm-backends).)

## Run & test

```bash
task server:dev     # tsx watch — hot-reloads on source changes
task server:start   # run once, no watch
task server:test    # check-test-boundaries + tsc --noEmit + vitest run
task server:cli -- <subcommand>   # config / app install / registry / workspace …
```

The server listens on `ws://localhost:3000` by default (a WebSocket endpoint —
opening it over HTTP shows nothing). Start it before launching any client.
