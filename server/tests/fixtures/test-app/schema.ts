/** Schema for the synthetic test-app fixture: a `notes` table with a category column. */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { id, timestamps } from 'moumantai'

export const notes = sqliteTable('notes', {
  ...id(),
  content: text('content').notNull(),
  category: text('category').notNull().default('general'),
  ...timestamps(),
})
