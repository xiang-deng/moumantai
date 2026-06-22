/**
 * Platform-DB `promotions` audit log.
 *
 * Append-only; one row per successful Promote. Lives on platform.db alongside
 * `conversations`. Discards are not logged.
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { id } from '../db/conventions.js'

export const promotions = sqliteTable('promotions', {
  ...id(),
  /** The draft that was promoted (its dir is gone by the time this is read). */
  draftId: text('draft_id').notNull(),
  /** The live app id the draft promoted into (agent-chosen id for new-app). */
  appId: text('app_id').notNull(),
  /** ISO-8601 timestamp of the successful promote. */
  promotedAt: text('promoted_at').notNull(),
  /** The agent's one-paragraph review summary captured at promote time. */
  summary: text('summary'),
  /** Number of dev-chat messages the draft accumulated before promote. */
  msgCount: integer('msg_count').notNull().default(0),
})

export type Promotion = typeof promotions.$inferSelect
export type NewPromotion = typeof promotions.$inferInsert
