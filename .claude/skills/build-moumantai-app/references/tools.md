# Tools (`defineTool`)

Tools are LLM-callable functions that mutate or query the app's DB. One file per tool under `apps/<id>/tools/`, default-exporting a `defineTool(...)` call.

Canonical examples:
- `apps/diet-tracker/tools/` — 6 tools covering insert/query/delete/aggregate/upsert
- `apps/spend-tracker/tools/add-expense.ts` — minimal insert-and-return

## Signature

From `server/src/server/agent/types.ts`:

```ts
interface ToolParameter {
  type: 'string' | 'number' | 'boolean'     // the whole union
  required?: boolean
  description?: string
}

interface ToolContext {
  params: Record<string, unknown>           // every read needs an `as` cast
  db: BetterSQLite3Database                 // Drizzle instance
}

interface ToolResult {
  result: unknown                           // what the LLM sees
  error?: string                            // set on clean failure
}
```

## Critical rules — canonical home for these

### Param types: string / number / boolean only

`ToolParameter.type` is a three-member union. There is **no** `'array'`, `'object'`, or enum type. For structured input:

- **List of items** — pass as JSON string: `{ type: 'string', description: 'JSON array of tag names' }`, then `JSON.parse(params.tags as string) as string[]` inside `execute`.
- **Enum** — `type: 'string'`, document allowed values in the description, validate inside `execute` and return `{ result: null, error: '...' }` on miss.

Inventing `{ type: 'array' }` breaks the wire format and fails the validator.

### Always cast `params`

`ctx.params` is `Record<string, unknown>`:

```ts
const amount = params.amount as number
const category = (params.category as string | undefined) ?? 'other'
```

Skipping the cast fails `tsc --noEmit`.

### Return shape

- Success: `return { result: <serializable> }` — `result` is what the LLM reads next.
- Handled failure: `return { result: null, error: 'Expense "xyz" not found' }` — LLM sees the error.
- Throwing is caught by the framework and surfaced as a generic error; prefer `{ error }`.

### Naming

Tools are `snake_case`, verb-first: `add_meal`, `delete_meal`, `query_meals`, `daily_summary`. The LLM fires them by name; keep names obvious.

## Drizzle patterns

The idioms below are shorthand — copy the full form from `apps/diet-tracker/tools/` or `apps/spend-tracker/tools/add-expense.ts`.

```ts
// insert + return
db.insert(meals).values({...}).returning().all()

// single select
db.select().from(meals).where(eq(meals.id, id)).get()

// filtered list with optional where
let q = db.select().from(meals).orderBy(desc(meals.eaten_at)).$dynamic()
if (params.meal_type) q = q.where(eq(meals.meal_type, params.meal_type as string))
q.all()

// aggregate
db.select({ total: sum(meals.calories), count: count() }).from(meals).get()

// delete with not-found error
const row = db.select().from(meals).where(eq(meals.id, id)).get()
if (!row) return { result: null, error: `Meal ${id} not found` }
db.delete(meals).where(eq(meals.id, id)).run()
```

For group-by, multi-join, or `sql\`...\``-based idioms, read `apps/diet-tracker/tools/daily-summary.ts` — it covers day-bucketing via `substr(eaten_at, 1, 10)`.

## One tool per file

One `defineTool({...})` default-exported per file. `index.ts` imports each tool explicitly. Keeps tests and reviews scoped.

## Source of truth

- `server/src/server/agent/types.ts` — `ToolDefinition`, `ToolParameter`, `ToolContext`, `ToolResult`.
- The `validate_tool` / `validate_types` MCP tools — enforce name pattern, param union, cast presence, and types at validation time.
- `apps/diet-tracker/tools/` — six worked examples.
- `apps/spend-tracker/tools/add-expense.ts` — minimal happy path.
