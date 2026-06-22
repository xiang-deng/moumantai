import { defineTool } from 'moumantai'
import { notes } from '../schema.js'

export default defineTool({
  name: 'add_note',
  description: 'Add a note to the test-app DB.',
  parameters: {
    content: { type: 'string', required: true, description: 'Note body' },
    category: { type: 'string', description: 'Category (default: general)' },
  },
  execute: async ({ params, db }) => {
    const rows = db
      .insert(notes)
      .values({
        content: params.content as string,
        category: (params.category as string) ?? 'general',
      })
      .returning()
      .all()
    return { result: { id: rows[0]!.id } }
  },
})
