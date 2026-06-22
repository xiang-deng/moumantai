import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'moumantai/ui',
        replacement: resolve(__dirname, 'src/server/protocol/components/index.ts'),
      },
      { find: 'moumantai', replacement: resolve(__dirname, 'src/server/framework/moumantai.ts') },
      // Subpath aliases must be declared before the bare-package one so vitest's
      // matcher prefers the more-specific match.
      {
        find: '@moumantai/protocol/generated/moumantai/v1',
        replacement: resolve(__dirname, '../shared/protocol/src/generated/moumantai/v1/index.ts'),
      },
      {
        find: '@moumantai/protocol/design-system',
        replacement: resolve(
          __dirname,
          '../shared/protocol/design-system/generated/design-system.ts',
        ),
      },
      {
        find: '@moumantai/protocol',
        replacement: resolve(__dirname, '../shared/protocol/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Device pairing defaults ON in production, but the suite mostly connects
    // fresh (unpaired) devices to exercise other features. Default it OFF for
    // tests; the dedicated pairing test opts back in per-server via
    // `createAppServer({ pairingRequired: true })` (opts override env).
    env: { MOUMANTAI_PAIRING_REQUIRED: 'false' },
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts'],
      exclude: ['src/server/**/types.ts', 'src/server/**/*.d.ts'],
    },
  },
})
