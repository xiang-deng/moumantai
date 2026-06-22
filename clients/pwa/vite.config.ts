/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      injectRegister: 'auto',
      includeAssets: ['audio-worklet/pcm-capture-worklet.js'],
      manifest: {
        name: 'Moumantai',
        short_name: 'Moumantai',
        description: 'Self-hosted Moumantai browser and installable PWA client',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0a0a0c',
        theme_color: '#0a0a0c',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          // Padded into the inner 80% safe zone so Android's circular/squircle
          // mask doesn't crop the artwork. Generated from icon.png.
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Precache the app shell only. WebSocket + same-origin API traffic
        // must always hit the live server — no runtime caching.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico}'],
        // Don't precache the worklet via Workbox's standard pattern — it's
        // already in includeAssets above and referenced by `/audio-worklet/...`.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/apps\//],
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: '@moumantai/protocol/generated/moumantai/v1',
        replacement: resolve(
          __dirname,
          '../../shared/protocol/src/generated/moumantai/v1/index.ts',
        ),
      },
      {
        find: '@moumantai/protocol/design-system',
        replacement: resolve(
          __dirname,
          '../../shared/protocol/design-system/generated/design-system.ts',
        ),
      },
      {
        find: '@moumantai/protocol',
        replacement: resolve(__dirname, '../../shared/protocol/src/index.ts'),
      },
    ],
  },
  // Allow reaching the dev/preview servers by hostname — a Tailscale MagicDNS
  // name, or anything behind Tailscale Serve — not just localhost/IP. Vite
  // otherwise rejects unknown Host headers ("host is not allowed"). These
  // servers only serve the static app shell; the data/API surface is the
  // separate WebSocket server (port 3000), gated by device pairing, so
  // accepting any Host here is low-risk for a self-hosted deployment.
  server: {
    port: 5174,
    fs: { allow: ['..'] },
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // material-color-utilities@0.4.0 is published as ESM with implicit `.js`
    // extensions in internal imports — Node's strict ESM resolver rejects
    // those. Inline-transform it so Vite (which is lenient about extensions)
    // bundles it through esbuild. Production builds get the same treatment
    // for free; this option only changes the test environment.
    server: {
      deps: {
        inline: ['@material/material-color-utilities'],
      },
    },
  },
})
