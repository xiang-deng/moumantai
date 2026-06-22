# Moumantai PWA client

The browser and installable PWA client — a thin React renderer that connects to a
running Moumantai server over WebSocket. See the [root README](../../README.md)
for the project overview and one-time setup.

## Prerequisites

- Toolchain installed (`mise install` from the repo root) and `npm install` run
  from the repo root — the PWA is an npm workspace, not a standalone package.
- **A Moumantai server must be running first** — set it up and start it via the
  [root Quick start](../../README.md#quick-start) (`task server:init`, then
  `task server:dev`). The PWA is only a renderer; with no server it has nothing
  to connect to.

## Develop

```bash
task pwa:dev        # or: npm run dev -w clients/pwa
```

The Vite dev server runs on **http://localhost:5174**. The backend lives on
**:3000** — `clients/pwa/.env.development` sets `VITE_WS_URL=ws://localhost:3000`
so the WebSocket points at the server rather than the dev server.

This mode is intentionally local-only: it has no production service worker, is
not installable, and embeds a localhost WebSocket URL. Use the production
Tailscale mode below for another device.

**Server URL resolution** — first hit wins:

| Priority | Source | Set via |
|---|---|---|
| 1 | `localStorage.moumantai.serverUrl` | at runtime, in the in-app Settings |
| 2 | `VITE_WS_URL` | build-time env (`.env.development` ships `ws://localhost:3000`) |
| 3 | same-origin `wss://<host>` | fallback for deployments that co-serve the PWA and WebSocket |

## Pairing

Pairing is on by default — the server only accepts allowlisted devices. On first connect the PWA shows a **pairing code**. Approve it from the checkout with `task server:cli -- device pair`, then type `approve <code>` at its prompt — or disable it for local-only dev via `task server:cli -- config edit`. See the root [Quick start](../../README.md#quick-start).

## Build & test

```bash
task pwa:build      # tsc --noEmit && vite build  (production PWA bundle)
task pwa:serve      # local installable PWA at http://localhost:4173
task pwa:test       # tsc --noEmit && vitest run
npm run preview -w clients/pwa   # preview a production build locally
```

## Secure remote access with Tailscale

For an installable PWA on a phone or another tailnet device, build with the
tailnet WebSocket URL and expose the two loopback services separately:

```bash
# Terminal A
task server:dev

# Terminal B
task pwa:serve:tailscale TAILSCALE_HOST=<host>.<tailnet>.ts.net

# Terminal C
tailscale serve --bg --https=443 http://localhost:4173
tailscale serve --bg --https=8443 http://localhost:3000
```

Open `https://<host>.<tailnet>.ts.net`. The production bundle connects to
`wss://<host>.<tailnet>.ts.net:8443`, avoiding mixed content while keeping both
services inside the tailnet. Pair the device as described above.
