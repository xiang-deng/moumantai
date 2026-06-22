import type { ScaffoldComponent, TopBarComponent } from '@moumantai/protocol/generated/moumantai/v1'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic, RenderNode } from '../RenderNode'
import type { RenderParent } from '../RenderNode'
import { useDispatchArgs } from '../renderer-utils'
import { scaffoldBodyClass } from '../variants'

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

const SCAFFOLD_TOP_BAR_PARENT: RenderParent = {
  kind: 'Scaffold',
  slotIndex: 0,
  slotName: 'top_bar',
}
const SCAFFOLD_BODY_PARENT: RenderParent = { kind: 'Scaffold', slotIndex: 0, slotName: 'body' }
const SCAFFOLD_FAB_PARENT: RenderParent = { kind: 'Scaffold', slotIndex: 0, slotName: 'fab' }

export function ScaffoldRenderer({
  def,
  surfaceId,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<ScaffoldComponent>) {
  const bodyClass = scaffoldBodyClass(def.bodyKind)
  return (
    <div className="moumantai-scaffold" style={modifierStyle}>
      {def.topBar && (
        <RenderNode
          componentId={def.topBar}
          surfaceId={surfaceId}
          itemScope={itemScope}
          dispatch={dispatch}
          parent={SCAFFOLD_TOP_BAR_PARENT}
        />
      )}
      {def.body && (
        <div className={bodyClass}>
          <RenderNode
            componentId={def.body}
            surfaceId={surfaceId}
            itemScope={itemScope}
            dispatch={dispatch}
            parent={SCAFFOLD_BODY_PARENT}
          />
        </div>
      )}
      {def.fab && (
        <RenderNode
          componentId={def.fab}
          surfaceId={surfaceId}
          itemScope={itemScope}
          dispatch={dispatch}
          parent={SCAFFOLD_FAB_PARENT}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export function TopBarRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<TopBarComponent>) {
  const title = (resolveDynamic(def.title, data, itemScope) as string) ?? ''
  const navAction = def.navigationAction

  const onBack = navAction
    ? () => {
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(navAction, surface, componentId, itemScopeData)
      }
    : undefined

  return (
    <div className="moumantai-topbar" style={modifierStyle}>
      {navAction && (
        <button className="moumantai-topbar-nav" onClick={onBack}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 'var(--moumantai-icon-size)' }}
          >
            arrow_back
          </span>
        </button>
      )}
      <span className="moumantai-topbar-title">{title}</span>
      <div className="moumantai-topbar-actions">
        {def.actions.map((actionId, i) => (
          <RenderNode
            key={actionId}
            componentId={actionId}
            surfaceId={surfaceId}
            itemScope={itemScope}
            dispatch={dispatch}
            parent={{ kind: 'TopBar', slotIndex: i, slotName: null } satisfies RenderParent}
          />
        ))}
      </div>
    </div>
  )
}
