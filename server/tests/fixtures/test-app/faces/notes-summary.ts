import { defineFace } from 'moumantai'
import { scaffold, column, text, pathRef } from 'moumantai/ui'
import { and, count, eq, type SQL } from 'drizzle-orm'
import { notes } from '../schema.js'

export type NotesSummaryParams = {
  /** Filter to one category. Omit for all. */
  category?: string
}

/** Parameterized face — count filtered by `category` (default: all categories). */
export default defineFace({
  id: 'notes-summary',
  label: 'Notes Summary',
  position: 1,
  params: {
    category: {
      type: 'string',
      description: 'Filter to one category id. Omit to count all categories.',
    },
  },
  viewToolDescription:
    'Show the Notes Summary face. Pass `category` to filter to one category, or `{}` for all.',
  components: [
    scaffold('root', { body: 'content' }),
    column('content', ['count_label']),
    text('count_label', pathRef('/summary/count')),
  ],
  resolve: ({ db, params }) => {
    const category = (params as NotesSummaryParams).category ?? null
    const filters: SQL[] = []
    if (category) filters.push(eq(notes.category, category))
    const where = filters.length > 0 ? and(...filters) : undefined
    const agg = where
      ? db.select({ total: count() }).from(notes).where(where).get()
      : db.select({ total: count() }).from(notes).get()
    return {
      summary: {
        count: agg?.total ?? 0,
        category: category ?? 'all',
      },
    }
  },
})
