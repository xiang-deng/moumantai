import { defineConfig } from 'drizzle-kit'

// Fallback config for `npx drizzle-kit generate` invoked with no args — points
// at the canonical example app. The first-class entry point is
// `npm run db:generate -- <app-id>` (see `.claude/skills/build-moumantai-app/scripts/db-generate.ts`),
// which sets --schema / --out per app and ignores this file. For the platform
// (chat-history) schema, use `npx drizzle-kit generate --config=./drizzle.platform.config.ts`.
export default defineConfig({
  dialect: 'sqlite',
  schema: '../apps/spend-tracker/schema.ts',
  out: '../apps/spend-tracker/drizzle',
  tsconfig: './tsconfig.json',
})
