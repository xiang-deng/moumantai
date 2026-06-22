# App structure

Where files go and how the platform finds them. Naming rules are in SKILL.md's pinned table; the MCP validators enforce them. You author inside your draft worktree (cwd) — the paths below are relative to it.

## Directory tree

```
apps/<app-id>/
  design.md                          # Phase-1 design doc (committed)
  manifest.ts                        # AppManifest
  index.ts                           # AppDefinition factory
  schema.ts                          # Drizzle tables
  drizzle/                           # generated migrations (committed)
    0000_<adjective>_<noun>.sql
    meta/_journal.json
    meta/0000_snapshot.json
  tools/
    <verb-noun>.ts                   # kebab-case filename; snake_case tool name inside
  faces/
    <face-id>/
      <face-id>.compact.ts           # compact variant (≤240dp); mandatory
      <face-id>.expanded.ts          # expanded variant (>240dp); mandatory
      <face-id>.resolve.ts           # shared resolver — imported by every variant
      <face-id>.parts.ts             # shared components — optional
    <another-face>/
      ...
```

Per-face subdir keeps one face's 4 files together. This is the supported layout.

(Runnable tests are NOT authored inside the draft in v1 — the MCP validators + the diff-scoped typecheck are the correctness gate. Don't write to `server/tests/`; it's outside your draft.)

## Discovery contract (`app-loader.ts`)

- Scans `apps/` (configurable) for subdirs with `index.ts` / `index.js`.
- For each: imports module, calls the factory via `resolveModuleExport`:
  1. `mod.default` if it's a function.
  2. Named export matching `/^create.+Def$/i`.
  3. `createAppDef`.
  4. Module namespace as-is.
- Validates via `validateAppDef` — duck-types `manifest` (id/name/icon/description non-empty strings; id matches `/^[a-z][a-z0-9-]*$/`, not `"home"`), `tools[]` (`{name:string, execute:function}`), `faces[]` (`{id:string, resolve:function}`), optional `schema`, `skill`, `migrationsFolder`.
- `parseFaceFile` recognizes `.compact` / `.expanded` suffixes and skips `.resolve.ts` and `.parts.ts`.
- `scanSupplementalFaces` recurses one level into face subdirs.

## Factory pattern (`index.ts`)

Export a named factory `create<PascalName>Def()`. The loader picks it up automatically.

```ts
import type { AppDefinition } from 'moumantai'
import { manifest } from './manifest.js'
import * as schema from './schema.js'
import addExpense from './tools/add-expense.js'
import summaryFace from './faces/summary/summary.compact.js'  // default (compact) variant only
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export function createSpendTrackerDef(): AppDefinition {
  return {
    manifest,
    schema,
    migrationsFolder: resolve(__dirname, 'drizzle'),
    tools: [addExpense],           // list all your tools here
    faces: [summaryFace],          // default variant only — framework scans for .expanded.ts
    skill: 'You manage expense tracking. Users can add, view, and delete expenses.',
  }
}
```

## The ESM `__dirname` idiom

Node ESM has no `__dirname`. The factory computes it from `import.meta.url`:

```ts
import { resolve } from 'path'
import { fileURLToPath } from 'url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))
migrationsFolder: resolve(__dirname, 'drizzle'),
```

Non-negotiable if `migrationsFolder` is set. Without it, drizzle can't find migrations and the integration test fails at boot.

## The `skill:` field

`AppDefinition.skill?: string` becomes a system-prompt hint when the user chats with this app. One or two sentences, domain-specific:

```ts
skill: 'You manage diet tracking. Users log meals with calories. Categorize common foods by macro profile when possible.',
```

Every real app sets it. Omitting it degrades the LLM's tool-selection.

## Imports — only these roots

The validator enforces the whitelist:

```ts
// Core SDK
import type { AppManifest, AppDefinition, ToolDefinition, FaceDefinition,
              ToolContext, ToolResult, ToolParameter, FaceResolve,
              ComponentDef } from 'moumantai'
import { defineTool, defineFace, id, timestamps } from 'moumantai'

// UI builders
import { scaffold, topBar, column, row, card,
         text, icon, image, divider,
         button, chip,
         textField, checkBox, switchToggle, slider, tabs, select, dateTimeInput,
         list, listItem,
         progress, modal,
         pathRef, serverEvent, localOps, combinedAction,
         opSet, opToggle, opIncrement, opDecrement,
         type ComponentDef, type ActionDef, type LocalOp, type ModifierProps } from 'moumantai/ui'

// Drizzle
import { sqliteTable, text as tText, integer, real } from 'drizzle-orm/sqlite-core'
import { sql, eq, desc, asc, and, or, sum, count, gt, lt, gte, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

// Node stdlib (index.ts only, for __dirname)
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// Local files — MUST include .js extension
import { manifest } from './manifest.js'
import * as schema from './schema.js'
import addMeal from './tools/add-meal.js'
import summaryFace from './faces/summary/summary.js'
```

**Never** import from `server/src/server/...` (framework internals). **Never** cross `client/ ↔ server/`. **Always** `.js` on local imports — ESM fails at runtime without it.

### Name collisions

- `resolve` — `path.resolve` vs a face's `.resolve.ts` export. Never import both into the same file; rename the face import if needed: `import { resolve as resolveToday } from './today.resolve.js'`.
- `text` — drizzle's column type vs `moumantai/ui`'s component builder. Schema files don't render UI and face files don't declare columns, so this rarely bites — but alias if it does.

## Built-in vs plugin

- **Built-in**: `server/src/server/apps/home/` — loaded at startup via hardcoded path. Only `home` is built-in.
- **Plugin**: `apps/<id>/` — discovered by `loadApps()`. What you write.

Structure identical; only location differs.

## Source of truth

- `server/src/server/agent/app-loader.ts` — discovery, factory resolution, file-name parsing.
- `server/src/server/agent/types.ts` — `AppDefinition`, `AppManifest`.
- The MCP validators (`validate_face` / `validate_tool` / `validate_types`) enforce the import whitelist, factory shape, and `.js`-extension rule at validation time.
- `apps/spend-tracker/index.ts` — canonical factory (5 tools, 2 faces).
- `apps/diet-tracker/index.ts` — factory with 6 tools + 3 faces.
