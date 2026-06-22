# Design-doc rubric (Phase 1)

The Phase-1 design doc at `apps/<id>/design.md` is the gate between "I have an idea" and "I am writing code." ~80–150 lines, three screens. Every later file traces back to it.

A complete doc covers six sections in order: product brief, data model, tool inventory, face inventory, size-class plan, test plan. The rules below describe each; the worked example at the bottom (diet-tracker) shows the shape.

## Section-by-section checklist

### 1. Product brief (5–10 lines)

- One-sentence pitch.
- 3–5 user stories: "As a <user> I can <action> so that <outcome>."
- Non-goals: one line listing what the app does NOT do (scope-creep fence).

### 2. Data model (10–30 lines)

A small table per table in `schema.ts`:

```
### `meals`
| Column | Type | Notes | Justified by |
| id | uuid | auto | — |
| name | text notnull | display name | US-1 |
| calories | integer notnull | kcal | US-2 |
```

Every non-timestamp column traces to a user story. An unjustified column is either missing a story or is scope creep.

### 3. Tool inventory (15–40 lines)

Per tool:

```
### `add_meal`
- Purpose: append one meal row
- Params: name:string(req), calories:number(req), meal_type:string(req), eaten_at:string?
- Success: `return { result: { success: true, id: <uuid> } }`  ← outer `{ result: ... }` is required by ToolResult
- Failure: `return { result: null, error: '...' }` on invalid input
- Story: US-1
```

Every `Success:` line must show the outer `{ result: ... }` wrapper — authors who pattern-match on a missing wrapper write `return { success: true, id }` and fail `tsc`. No orphan tools (no user story → delete or add a story).

### 4. Face inventory (30–80 lines)

**Most apps ship 2–4 faces.** A single-face app is rare enough to justify explicitly. Per face, declare the **resolver output shape** as a JS/TS object literal — that shape IS the contract.

```
### `today` (position: 0) — primary view

Purpose: show today's calories and progress toward goal; default landing face.

Resolver output:
{
  day: {
    date: string,             // ISO 'YYYY-MM-DD' in the app's DISPLAY timezone — same tz at write + read (see external-data-apps.md "date bucketing"); UTC-slicing mis-buckets evening events
    total_calories: number,
    meal_count: number,
    goal_calories: number,    // 0 if no goal set
    percent_of_goal: number,  // 100 when no goal (see ux.md ring pattern)
  },
  meals: [ { id, name, calories, meal_type, eaten_at } ]
}

Variants:
- today/today.compact.ts   — compact; watch/iot-small; progress ring + meal count
- today/today.expanded.ts  — phone; TopBar "Today"; ring + meal list + add-meal chip
```

Rules of thumb:
- Face id is user-facing singular (`today`, `history`, `goals`). Not `summary`, not `main`.
- Compact variant mandatory, expanded typical.
- Two variants share one resolver. If two faces have identical shapes, they're the same face.
- Faces are read-only — mutations are tools fired from server events, not face logic.

### 5. Size-class plan (5–10 lines)

Compact (≤240dp): what's visible, what's hidden. Expanded (>240dp, including phone and HMI panels): deltas from compact.

Standard answer: compact = body only; expanded = + TopBar + padding. Exotic only if justified.

### 6. Test plan (10–30 lines)

- Integration: one `it(...)` per tool, one per face resolver, + boot/migrate/register smoke.
- E2E: four cases (launcher, compact, expanded, mutation).
- Per test, one sentence on what it asserts.

File names are not a plan. "Test X asserts Y given Z" is a plan.

## Worked example: diet-tracker

```
# Diet Tracker — design

## Product brief
Log meals throughout the day; see today's calories and progress toward a daily goal; review the past week; set / adjust the goal.

User stories:
- US-1: As a user, I can log a meal (name, calories, meal type, optional time).
- US-2: As a user, I can see today's total calories and a progress ring toward my goal.
- US-3: As a user, I can see the past 7 days' totals and whether I hit the goal each day.
- US-4: As a user, I can delete a meal I logged by mistake.
- US-5: As a user, I can set or change my daily calorie goal.

Non-goals: macros (protein/carbs/fat), recipes, integration with fitness devices.

## Data model
### meals
| id | name text notnull | calories integer notnull | meal_type text notnull | eaten_at text default CURRENT_TIMESTAMP | created_at | updated_at |
Justifies US-1..US-4.

### goals
| id | calories_per_day integer notnull | created_at | updated_at |
Most-recent row wins; edits append. Justifies US-5.

## Tools
- add_meal (US-1)
- query_meals (US-3) — meal_type?, days_back?, limit?
- delete_meal (US-4) — id
- daily_summary (US-2) — returns today's total + count + percent_of_goal
- set_daily_goal (US-5) — calories_per_day
- get_goal — returns current goal (or null)

## Faces
### today (position: 0) — primary
Resolver: { day: { date, total_calories, meal_count, goal_calories, percent_of_goal, total_display, goal_subtitle, has_goal }, meals }
Variants:
- today/today.compact.ts  — compact: ring (label=total_display, sublabel=goal_subtitle) + meal_count. No list on watch.
- today/today.expanded.ts — phone: TopBar "Today", ring + full meal list + "Add meal" chip.

### history (position: 1)
Resolver: { days: [ { date, total_calories, meal_count, hit_goal } ], range: { start, end, days: 7 } }
Variants: history/history.compact.ts (compact: last 3 days, hit/miss icon); history/history.expanded.ts (all 7 days with progress bars).

### goals (position: 2)
Resolver: { goal: { calories_per_day, set_at | null }, today_status: { total_calories, percent_of_goal, total_display, goal_subtitle } }
Variants: goals/goals.compact.ts (current goal, today's ring); goals/goals.expanded.ts (number input + "Save" button fires set_daily_goal).

## Size-class plan
Compact (default, watch/iot-small): body only, spacing 8; circular progress; avoid lists > 3.
Expanded (phone): TopBar per face; spacing 16, padding 16; primary-action chip.
Medium: falls back to default.

## Tests
Integration (server/tests/integration/<app-id>.test.ts — lives in apps repo per boundary rule):
- boots + migrates; registers 6 tools + 3 faces
- add_meal inserts row, returns id; rejects invalid meal_type
- query_meals with/without meal_type filter; with days_back
- delete_meal valid + not-found error path
- daily_summary handles no-goal case (percent_of_goal=100)
- set_daily_goal appends; get_goal returns most recent
- each face resolver asserts its declared shape

E2E (server/tests/e2e/test_<app_id>.py — lives in apps repo per boundary rule):
- launcher lists Diet Tracker
- phone default: Today face TopBar visible; ring rendered
- switch to watch: Today compact renders ring only (no TopBar, no list)
- vertical swipe: History, then Goals (position order)
- mutation (if LLM key): add a meal via chat → Today total updates; else SKIP
```

Every column, tool, face, and test in `apps/diet-tracker/` traces to a line here. That's the standard.

## Source of truth

- `.claude/skills/build-moumantai-app/templates/design.md.tmpl` — blank skeleton.
- `apps/diet-tracker/design.md` — the worked example as it actually shipped.
