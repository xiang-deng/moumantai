# UX patterns that make an app feel like an app

A correct Moumantai mini app passes `tsc`, migrates, renders, responds. A *good* one feels designed. The gap is small decisions made consistently: a real empty state, a reachable primary action, a glanceable compact variant, user-facing labels. This file is a checklist for the good ones.

## Navigation model: the 2D pager

The framework renders `AppPager` — horizontal swipe between apps, vertical swipe between faces within an app.

- **Each face is a full screen.** No tab bar, no side nav.
- **`position` is reading order.** 0 is where the user lands. Put the primary task first.
- **Users are one swipe from the secondary face.** Stop packing everything into one face.
- **Faces have no "back" stack.** For drill-down: either a modal from within one face, or another face with its own resolver.

## Empty states

Every face will be opened at least once with zero data. Handle it explicitly:

- Resolver returns sentinel zeros / empty arrays (`total: 0, meals: []`), never throws or returns undefined.
- Compact (watch) shows something useful when empty: "0 / 2000", a greyed ring, current time — not a blank screen.
- Expanded (phone) can show a one-sentence CTA above the list: "Log your first meal — chat to add."
- Never render `undefined` or `NaN%`. An empty list quietly not rendering rows is fine; a "NaN" label is not.

## Primary actions

Every face should answer "what is the one thing a user does here?"

- **Today / now view** → log the new thing. Top-mounted `chip` or `button` fires the mutation tool directly via `invokeTool('add_x')`.
- **History view** → typically read-only; primary action is "open a day" (`listItem` with `action: invokeTool('view_x', { date })`).
- **Goals / settings** → edit the goal. Number `textField` + "Save" `button` that fires the set-goal tool with the field bound via `pathRef('/$form/<field_id>')`.

On watch: one full-width chip, 1–2 words. No FAB. Numeric input opens the platform's voice/full-screen overlay — don't inline.

On phone: a top-of-column `chip` with an `add` icon and a verb-noun label ("Log meal", "Add task", "Set goal" — not "Add" / "Submit"). **Do not use `scaffold.fab`.** The framework renders a chat FAB at `bottom: 16px; right: 16px` (`.chat-fab`, z-index 50) and Scaffold's `fab` slot renders `.moumantai-fab` at the same anchor (z-index 5) — the two overlap and the chat FAB visually hides the app FAB. The bottom-right corner belongs to the framework on the PWA; plugin apps own the body column. Diet-tracker (`apps/diet-tracker/faces/today/today.expanded.ts`) and the Todo app follow this convention.

### Faces are dashboards + intent triggers; chat is the form

Wire chips and buttons at the **mutation tool itself** — never at "intent-stub" tools whose only purpose is to wave at the LLM. If the UI doesn't supply every required arg (e.g. a "Log meal" chip with no form, or "Save goal" with the field empty), the framework asks the user for the missing values via chat using each missing param's `description`, then calls the tool with typed args. Authors don't think about escalation — write the mutation tool and wire the affordance at it.

Param descriptions are **user-visible** (the LLM rephrases them naturally into a question). Write them as short noun phrases — `'daily kcal target'`, `'meal name'` — not as schema commentary.

```ts
// Right: chip fires the real mutation tool. Empty args → chat asks.
chip('log_meal_chip', 'Log meal', { action: invokeTool('add_meal') })

// Right: Save fires the mutation directly; framework escalates if field is empty.
button('save_button', 'Save goal', {
  action: invokeTool('set_daily_goal', { calories_per_day: pathRef('/$form/goal_field') }),
})

// Wrong: stub tool whose only job is to wave at the LLM.
// This worked before chat escalation; today it's a dead pattern.
chip('log_meal_chip', 'Log meal', { action: invokeTool('log_meal_intent') })
```

## State × time semantics

If your face shows tasks (or any items) that have both a *planned* date and a *completion* date — todo apps, habit trackers, queue-style work apps — these two dates are **orthogonal axes**, never the same filter.

- **Pending** state is anchored on the *plan date* (`due_date`, `scheduled_for`, etc.) — "when I said I'd do it."
- **Completed** state is anchored on the *activity date* (`completed_at`, `finished_at`, etc.) — "when I actually did it."

Mixing them — e.g. filtering "today's completed" by `due_date = today` — is the bug pattern. A task scheduled for yesterday and completed today won't appear, but the user (and chat — see below) consider it "done today." The face under-reports.

### The chat-vs-face alignment constraint (specific to Moumantai)

This is what makes the rule sharper than "Things 3 does it this way." Our framework's chat is always-on and reasons over the database directly. When the user asks chat *"what did I do today?"*, the LLM will look at `completed_at` timestamps. The face MUST surface the same set somewhere visible — otherwise the user sees one number on the face and a different number from chat, and the surfaces feel inconsistent. **Hidden-by-default toggles are not enough**; the gap is structural.

### Today face pattern (apply this verbatim for any "today / now" view)

A Today face must surface both axes:

| Section | Filter | Anchor | Visibility |
|---|---|---|---|
| Pending — Overdue | `due_date < today AND completed_at IS NULL` | plan date | always (when ≥1) |
| Pending — Today | `due_date = today AND completed_at IS NULL` | plan date | always (when ≥1) |
| **Logbook — Completed today** | `substr(completed_at, 1, 10) = today` | activity date | **always (when ≥1) — no toggle** |

Tap behavior: pending row checkbox → `complete_<thing>(id)`; Logbook row checkbox starts checked → `uncomplete_<thing>(id)` (the undo affordance). Filter chips at the top steer the *pending* sections only — Logbook is a record, never filtered.

The hero (ring or stat line) reflects the *plan*: "are you on top of today's plan?" — not "how busy were you today." Off-plan completions (overdue, future-completed-early, inbox-completed) appear in the Logbook but don't move the hero. Watch variants typically drop the Logbook (small screen, pending-glance only).

### Other time-anchored faces (Upcoming / This week / etc.)

Show **pending only**. Their completions naturally surface in Today's Logbook on the day of completion — there's no need to repeat a Logbook section per face. The Today face is the daily concentrator.

### Reference implementation

`apps/todo/faces/today/` ships this pattern end-to-end. Resolver in `today.resolve.ts` runs three queries (overdue-pending, today-pending, completed-today via `substr(completed_at, 1, 10) = today`) and bakes section flags + stat-line spans + watch ring labels. Phone face (`today.expanded.ts`) composes Add chip → filter rail → date title → stat line OR celebration → three sections; watch face (`today.ts`) keeps the ring hero + a one-line headline.

## Progress and feedback

No chart components. Use what's there:

- **Daily goal ring** — `progress` with `variant: 'circular'`. Fitness-ring pattern.
- **Per-item progress bar** — `progress(..., { variant: 'linear' })` inside a `listItem` trailing slot. Not on watch.
- **Hit/miss icon** — `icon('hit', 'check_circle')` vs `icon('miss', 'cancel')` chosen by the resolver.
- **Relative time** — no built-in. Format in the resolver: `"3h ago"`, `"Yesterday"`, `"Apr 16"`.

### The ring anti-pattern (don't ship this)

```ts
// Ring is an empty circle framing whitespace; the number floats below as a disconnected
// sibling. If percent is 0 (no goal yet), the ring has NO colored fill — looks broken.
progress('goal_ring', pathRef('/day/percent_of_goal'), 100, { variant: 'circular' }),
text('total_value', pathRef('/day/total_calories'), { typography: 'displayLarge' }),
text('total_label', 'calories today', { typography: 'labelMedium' }),
```

### The ring pattern that works

```ts
// label + sublabel render INSIDE the ring. Big number is the headline, its context is
// the subtitle, the arc is the glanceable progress.
progress('goal_ring', pathRef('/day/percent_of_goal'), 100, {
  variant: 'circular',
  label: pathRef('/day/total_display'),      // "650" — center of ring
  sublabel: pathRef('/day/goal_subtitle'),   // "of 2000 kcal" or "no goal set"
  size: 180,                                  // 180 on phone; at most 100 on compact
}),
```

Paired resolver:

```ts
const hasGoal = goalCals > 0
return {
  day: {
    total_calories: total,
    total_display: String(total),             // label is DynamicValue<string>
    goal_subtitle: hasGoal ? `of ${goalCals} kcal` : 'no goal set',
    percent_of_goal: hasGoal
      ? Math.min(100, Math.round((total / goalCals) * 100))
      : 100,                                   // full ring when no goal — not empty
  },
}
```

Two subtle rules:
1. `label` / `sublabel` are strings — always `String(n)` before passing a number.
2. When no goal is set, return `percent_of_goal: 100`. An empty arc reads as "broken"; a full arc + "no goal set" subtitle reads as "waiting for setup."

## User-facing labels

- `face.id` = `today`, `history`, `goals` — short, stable, snake_case.
- `face.label` = `"Today"`, `"This week"`, `"Goals"` — title case, user-facing.

Avoid `"summary"` as an id or label — engineer-speak. Pick a word from the user's vocabulary. Same for app display names and tool descriptions: `"Log a meal with its name, calories, and meal type."` — not `"Insert into meals table."`.

## Size-class discipline

Watch (compact) is not "phone minus rows." It's a different screen with different affordances.

| Thing | Watch | Phone |
|---|---|---|
| TopBar | no | yes — titled with face label |
| Spacing | 8 | 16 |
| Padding | 0 or small | 16 |
| Lists | ≤ 3 rows visible; often none | scrolling |
| Primary input | chip → overlay | inline textfield, button |
| Progress | circular only | circular OR linear |
| Typography | one level smaller | full scale |

When in doubt on watch: **one number, one label.** 100 / 2000. Ring around it. Done.

## Resolver-side work beats component-side work

Every time you're tempted to compute in a component (string concat, formatting, conditionals), move it to the resolver. Components bind to paths; resolvers produce shapes.

- Format currency (`$12.50`) in the resolver.
- Format dates (`Apr 16`, `3h ago`) in the resolver.
- Compute percentages in the resolver.
- Choose icon names (`check_circle` vs `cancel`) in the resolver. Default names are Material Symbols; prefix with `fa:` to use FontAwesome Free when Material doesn't have the glyph (`fa:cart-plus`, `fa:brands:github`). Prefer Material — `fa:` is an escape hatch.
- Build display-ready list rows `{ id, headline, supporting, trailing }` in the resolver.

This keeps components mechanically generatable and domain logic in one testable function.

## The three questions before shipping a face

1. **What does this face tell me at a glance?** If you can't answer in five words, it's doing too much.
2. **What is the one action I'll take here?** If unclear, there's no primary action; decide.
3. **Does the watch version work with one look?** If the user scrolls or squints, redesign compact.

## Source of truth

- `apps/diet-tracker/faces/today/` — ring pattern done correctly.
- `clients/pwa/src/renderer/renderers/feedback.tsx` — ProgressRenderer; shows where `label`/`sublabel` render.
