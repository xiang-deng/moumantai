/**
 * Pattern expansion tests — every SDK pattern emits a stable primitive tree.
 *
 * Patterns are domain-agnostic helpers over primitives. The wire stays at 23
 * primitives + 1 enum field; patterns are TS-only sugar. Renderers don't see
 * patterns — they see the emitted primitive trees. These tests pin the
 * emitted shape so renderer + visual-snapshot expectations don't drift.
 */

import { describe, it, expect } from 'vitest'
import {
  hero,
  kpi,
  emptyState,
  actionRow,
  detailHeader,
  sectionHeader,
  statusBadge,
  loadMore,
  scaffold,
  BodyKind,
} from '../../../src/server/protocol/components/index.js'
import { progressRing } from '../../../src/server/protocol/components/feedback.js'
import { text } from '../../../src/server/protocol/components/atoms.js'
import { invokeTool, pathRef } from '../../../src/server/protocol/components/common.js'

describe('SDK patterns', () => {
  it('hero wraps a single child in a centered Box', () => {
    const tree = hero('h', text('label', 'inside'))
    expect(tree).toHaveLength(2)
    expect(tree[0]?.id).toBe('h')
    expect(tree[0]?.component.case).toBe('box')
    expect(tree[1]?.id).toBe('label')
  })

  it('kpi stacks a value and label in a centered Column', () => {
    const tree = kpi('total_kpi', '650', 'kcal today')
    expect(tree).toHaveLength(3)
    expect(tree[0]?.id).toBe('total_kpi')
    expect(tree[0]?.component.case).toBe('column')
    expect(tree[1]?.id).toBe('total_kpi__value')
    expect(tree[2]?.id).toBe('total_kpi__label')
  })

  it('emptyState emits a message-only column when no action is given', () => {
    const tree = emptyState('empty', 'No tasks yet')
    expect(tree).toHaveLength(2)
    expect(tree[0]?.id).toBe('empty')
    expect(tree[1]?.id).toBe('empty__message')
  })

  it('emptyState appends a button when an action is given', () => {
    const tree = emptyState('empty', 'No tasks yet', {
      action: { label: 'Add task', action: invokeTool('add_task') },
    })
    expect(tree).toHaveLength(3)
    expect(tree[2]?.id).toBe('empty__primary')
    expect(tree[2]?.component.case).toBe('button')
  })

  it('actionRow emits a primary button only when secondary is absent', () => {
    const tree = actionRow('act', { label: 'Save', action: invokeTool('save') })
    expect(tree).toHaveLength(2)
    expect(tree[0]?.component.case).toBe('row')
    expect(tree[1]?.id).toBe('act__primary')
  })

  it('actionRow emits secondary + primary buttons when both are present', () => {
    const tree = actionRow(
      'act',
      { label: 'Save', action: invokeTool('save') },
      { label: 'Cancel', action: invokeTool('cancel') },
    )
    expect(tree).toHaveLength(3)
    expect(tree[1]?.id).toBe('act__primary')
    expect(tree[2]?.id).toBe('act__secondary')
  })

  it('detailHeader emits a topBar component', () => {
    const tree = detailHeader('header', 'Sports')
    expect(tree).toHaveLength(1)
    expect(tree[0]?.id).toBe('header')
    expect(tree[0]?.component.case).toBe('topBar')
  })

  it('sectionHeader emits a single Text when no supporting line', () => {
    const tree = sectionHeader('hdr', 'Today')
    expect(tree).toHaveLength(1)
    expect(tree[0]?.component.case).toBe('text')
  })

  it('sectionHeader emits a column + 2 texts when supporting is given', () => {
    const tree = sectionHeader('hdr', 'Today', { supporting: '5 tasks' })
    expect(tree).toHaveLength(3)
    expect(tree[0]?.component.case).toBe('column')
    expect(tree[1]?.id).toBe('hdr__title')
    expect(tree[2]?.id).toBe('hdr__supporting')
  })

  it('statusBadge emits a chip with assist variant', () => {
    const tree = statusBadge('live_pill', 'LIVE', { selected: true })
    expect(tree).toHaveLength(1)
    expect(tree[0]?.component.case).toBe('chip')
  })

  it('loadMore emits an outlined button with expand_more icon', () => {
    const tree = loadMore('more_btn', 'Load more', invokeTool('list_more'), {
      enabled: pathRef('/has_more'),
    })
    expect(tree).toHaveLength(1)
    expect(tree[0]?.component.case).toBe('button')
  })

  it('scaffold maps body_kind into the wire ScaffoldComponent', () => {
    // protobuf-es strips the proto enum-name prefix on the TS side:
    // `BODY_KIND_CANVAS` in .proto → `BodyKind.CANVAS` in TS.
    const canvas = scaffold('root', { body: 'content', body_kind: BodyKind.CANVAS })
    expect(canvas.component.case).toBe('scaffold')
    if (canvas.component.case === 'scaffold') {
      expect(canvas.component.value.bodyKind).toBe(BodyKind.CANVAS)
    }
    // Default (unset) — `create()` leaves bodyKind as undefined, which renderers
    // treat the same as BODY_KIND_UNSPECIFIED (== 0 == LIST per the wire default).
    const list = scaffold('root', { body: 'content' })
    if (list.component.case === 'scaffold') {
      const bk = list.component.value.bodyKind
      expect(bk === undefined || bk === BodyKind.UNSPECIFIED).toBe(true)
    }
  })

  it('hero composes naturally with progressRing (canonical glance face)', () => {
    const tree = hero('hero_box', progressRing('ring', 50, 100))
    expect(tree).toHaveLength(2)
    expect(tree[0]?.id).toBe('hero_box')
    expect(tree[1]?.id).toBe('ring')
    expect(tree[1]?.component.case).toBe('progressRing')
  })
})
