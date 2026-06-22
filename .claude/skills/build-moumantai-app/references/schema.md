# Schema and migrations

## The idiom

```ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { id, timestamps } from 'moumantai'

export const meals = sqliteTable('meals', {
  ...id(),
  name: text('name').notNull(),
  calories: integer('calories').notNull(),
  meal_type: text('meal_type').notNull(),       // 'breakfast' | 'lunch' | 'dinner' | 'snack'
  eaten_at: text('eaten_at').default(sql`(CURRENT_TIMESTAMP)`),
  ...timestamps(),
})
```

Every meaningful table gets `...id()` and `...timestamps()` — do not reinvent them.

## What `id()` and `timestamps()` produce

From `server/src/server/db/conventions.ts`:

- `id()` → `{ id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()) }`. SQL column `id`, UUID assigned at insert.
- `timestamps()` → `createdAt` + `updatedAt` as `text` with `CURRENT_TIMESTAMP` defaults; `updatedAt` also has `$onUpdate(() => new Date().toISOString())`. SQL columns are snake_case (`created_at`, `updated_at`); Drizzle field names are camelCase — use those when reading/writing in TS.

## Column types

| Use | Drizzle type | SQL type |
|---|---|---|
| Short string / enum-as-string | `text('col')` | `text` |
| Integer counts | `integer('col')` | `integer` |
| Currency / decimals | `real('col')` | `real` |
| Boolean | `integer('col', { mode: 'boolean' })` | `integer` |
| JSON blob (last resort) | `text('col', { mode: 'json' }).$type<Shape>()` | `text` |

SQLite has no DATE/TIMESTAMP — use `text` with ISO-8601 strings. Enum columns: `text` + TS union on read; validate in the tool.

Foreign keys:

```ts
meal_id: text('meal_id').notNull().references(() => meals.id),
```

**Foreign keys ARE enforced at runtime.** The live per-app DB is opened through Drizzle's better-sqlite3 connection, which turns `PRAGMA foreign_keys` **ON**. So a `references()` column is a real constraint, not just a type hint:

- You cannot insert a child row pointing at a missing parent.
- **You cannot delete a parent row while child rows still reference it** — it throws `FOREIGN KEY constraint failed` (and, inside a refresh task, that error aborts the whole tick).

So **any multi-table delete must remove children before parents.** Cache-prune example (`cache_game_detail.game_id → cache_games.id`):

```ts
// child first
db.delete(cache_game_detail)
  .where(sql`${cache_game_detail.game_id} IN (SELECT id FROM ${cache_games} WHERE ${cache_games.date} < ${cutoff})`)
  .run()
// then parent
db.delete(cache_games).where(lt(cache_games.date, cutoff)).run()
```

Keep FK references minimal, but never assume they are unenforced — order every delete child-first. See `references/external-data-apps.md` for the full cache-prune/retention pattern.

## Migration generation

After editing `schema.ts`, call the **`generate_migration`** MCP tool. It runs drizzle-kit against your draft's `schema.ts` AND applies the new migration to your shadow DB (`.shadow/db.sqlite`) — so the validators see the new columns immediately. (You can't run `npm`/drizzle-kit from Bash in the draft; `generate_migration` is the sandboxed equivalent.)

Output (written into your draft's `drizzle/`):
- `0000_<adjective>_<noun>.sql` — `CREATE TABLE` statements.
- `meta/_journal.json` — migration log.
- `meta/0000_snapshot.json` — schema snapshot for future diffs.

Without the SQL, boot runs `migrate(db, { migrationsFolder })` against a fresh DB and finds no tables.

## When schema changes

1. Edit `schema.ts`.
2. Call `generate_migration` again → a new `0001_*.sql` with just the delta, applied to the shadow DB.
3. Verify with `sqlite3 -readonly .shadow/db.sqlite ".schema <table>"`, then re-run `validate_face`/`validate_tool` for affected files.

## Don't

- Hand-edit generated `.sql`. Use `sql\`...\`` in `schema.ts` and call `generate_migration`.
- Add `drizzle/` to `.gitignore` — migrations are source.
- Import from `drizzle-orm/migrator` inside the app — the engine owns migrate.

## Source of truth

- `server/src/server/db/conventions.ts` — `id()`, `timestamps()` definitions.
- `.claude/skills/build-moumantai-app/scripts/db-generate.ts` — the wrapper's exact invocation.
- `apps/diet-tracker/schema.ts`, `apps/diet-tracker/drizzle/` — worked example.
