import { defineFace } from '../../../agent/define-face.js'
import { scaffold, topBar, column, text, pathRef } from 'moumantai/ui'

export default defineFace({
  id: 'main',
  label: 'Home',
  position: 0,
  viewToolDescription: 'Show the Moumantai home / launcher face.',
  components: [
    scaffold('root', { body: 'content', top_bar: 'top' }),
    topBar('top', 'Moumantai'),
    column('content', ['welcome', 'hint'], { spacing: 16, padding: 16 }),
    text('welcome', 'Welcome to Moumantai', { typography: 'headlineMedium' }),
    text('hint', pathRef('/hint'), { typography: 'bodyMedium' }),
  ],
  resolve: () => ({
    hint: 'Type a message to chat, or swipe to explore apps.',
  }),
})
