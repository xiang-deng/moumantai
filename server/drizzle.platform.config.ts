import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/server/conversations/schema.ts', './src/server/drafts/promotions-schema.ts'],
  out: './drizzle/platform',
  casing: 'snake_case',
})
