import { defineFace } from 'moumantai'
import { scaffold, column, text, pathRef } from 'moumantai/ui'
import { desc, count } from 'drizzle-orm'
import { notes } from '../schema.js'

/** Non-parameterized face — counts and lists all notes. */
export default defineFace({
  id: 'notes-list',
  label: 'All Notes',
  position: 0,
  viewToolDescription: 'Show all notes (count + recent list).',
  components: [
    scaffold('root', { body: 'content' }),
    column('content', ['count_label']),
    text('count_label', pathRef('/total')),
  ],
  resolve: ({ db }) => {
    const agg = db.select({ total: count() }).from(notes).get()
    const recent = db.select().from(notes).orderBy(desc(notes.createdAt)).limit(10).all()
    return { total: agg?.total ?? 0, recent }
  },
})
