import { text } from 'drizzle-orm/sqlite-core'

/** Standard UUID primary key. Auto-generated on insert. */
export const id = () => ({
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
})

/** Standard created_at / updated_at timestamps. ISO-8601 strings. */
export const timestamps = () => ({
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdate(() => new Date().toISOString()),
})
