import { describe, it, expect } from 'vitest'
import { defineFace } from '../../../src/server/agent/define-face.js'
import { validateFaceComponents } from '../../../src/server/agent/face-validation.js'
import {
  scaffold,
  column,
  list,
  listItem,
  text,
  textField,
  checkBox,
  switchToggle,
  slider,
  select,
  dateTimeInput,
  button,
  invokeTool,
  pathRef,
} from '../../../src/server/protocol/components/index.js'

// The list-template input guard rejects form-binding inputs inside repeating lists
// (`/$form/<id>` would collide across rows). Inputs with an `action` are allowed;
// the recommended pattern for editable rows is the modal-edit flow.

function faceOf(...components: ReturnType<typeof scaffold>[]) {
  return defineFace({
    id: 'test',
    label: 'Test',
    position: 0,
    viewToolDescription: 'Test face',
    components,
    resolve: () => ({}),
  })
}

describe('face validation — list-template input guard', () => {
  it('rejects a TextField inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'amount_input' }),
      textField('amount_input', '', 'kcal'),
    )
    const issues = validateFaceComponents(f)
    const guard = issues.find((i) => i.code === 'list-template-input')
    expect(guard).toBeDefined()
    expect(guard?.message).toMatch(/TextField/)
    expect(guard?.componentId).toBe('amount_input')
  })

  it('rejects a Slider without action inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'volume_slider' }),
      slider('volume_slider', 0, { min: 0, max: 100 }),
    )
    const issues = validateFaceComponents(f)
    const guard = issues.find((i) => i.code === 'list-template-input')
    expect(guard).toBeDefined()
    expect(guard?.message).toMatch(/slider/)
  })

  it('accepts a Switch with action inside a list template (fires on change)', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'done_switch' }),
      switchToggle('done_switch', false, {
        action: invokeTool('toggle_task', { id: pathRef('$.id') }),
      }),
    )
    const issues = validateFaceComponents(f)
    expect(issues.find((i) => i.code === 'list-template-input')).toBeUndefined()
  })

  it('accepts a CheckBox with action inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'done_check' }),
      checkBox('done_check', '', false, {
        action: invokeTool('toggle_task', { id: pathRef('$.id') }),
      }),
    )
    const issues = validateFaceComponents(f)
    expect(issues.find((i) => i.code === 'list-template-input')).toBeUndefined()
  })

  it('accepts a read-only Text descendant inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { supporting: pathRef('$.amount') }),
    )
    const issues = validateFaceComponents(f)
    expect(issues.find((i) => i.code === 'list-template-input')).toBeUndefined()
  })

  it('accepts a Button (action-only) inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'delete_btn' }),
      button('delete_btn', 'Delete', {
        action: invokeTool('delete_item', { id: pathRef('$.id') }),
      }),
    )
    const issues = validateFaceComponents(f)
    expect(issues.find((i) => i.code === 'list-template-input')).toBeUndefined()
  })

  it('rejects a Select without action even when nested through a row Card', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'pick' }),
      select('pick', '', { options: [{ label: 'A', value: 'a' }] }),
    )
    const issues = validateFaceComponents(f)
    const guard = issues.find((i) => i.code === 'list-template-input')
    expect(guard).toBeDefined()
    expect(guard?.componentId).toBe('pick')
  })

  it('accepts a DateTimeInput with action inside a list template', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['rows']),
      list('rows', '/items', 'row'),
      listItem('row', pathRef('$.name'), { trailing_content: 'when' }),
      dateTimeInput('when', '', undefined, {
        mode: 'date',
        action: invokeTool('reschedule', { id: pathRef('$.id') }),
      }),
    )
    const issues = validateFaceComponents(f)
    expect(issues.find((i) => i.code === 'list-template-input')).toBeUndefined()
  })

  it('faces with no list still validate cleanly', () => {
    const f = faceOf(
      scaffold('root', { body: 'content' }),
      column('content', ['title']),
      text('title', 'hello'),
    )
    const issues = validateFaceComponents(f)
    expect(issues).toEqual([])
  })
})
