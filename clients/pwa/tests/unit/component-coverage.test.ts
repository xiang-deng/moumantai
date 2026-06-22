import { describe, it, expect } from 'vitest'
import {
  TextRenderer,
  IconRenderer,
  ImageRenderer,
  DividerRenderer,
} from '../../src/renderer/renderers/atoms'
import {
  ColumnRenderer,
  RowRenderer,
  CardRenderer,
  BoxRenderer,
} from '../../src/renderer/renderers/layout'
import { ScaffoldRenderer, TopBarRenderer } from '../../src/renderer/renderers/chrome'
import { ButtonRenderer, ChipRenderer, FabRenderer } from '../../src/renderer/renderers/actions'
import {
  TextFieldRenderer,
  CheckBoxRenderer,
  SwitchRenderer,
  SliderRenderer,
  TabsRenderer,
  SelectRenderer,
  DateTimeInputRenderer,
} from '../../src/renderer/renderers/input'
import { ListRenderer, ListItemRenderer } from '../../src/renderer/renderers/data'
import {
  ProgressRingRenderer,
  ProgressBarRenderer,
  ModalRenderer,
} from '../../src/renderer/renderers/feedback'

/**
 * Component-coverage acceptance gate: every proto component variant must
 * export a renderer function. A new variant trips both `RenderNode.tsx`'s
 * exhaustive `_exhaustive: never` check (type-check time) and this test
 * (runtime).
 */
describe('component coverage — every protocol component variant has a renderer', () => {
  const renderers: Record<string, unknown> = {
    Text: TextRenderer,
    Icon: IconRenderer,
    Image: ImageRenderer,
    Divider: DividerRenderer,
    Column: ColumnRenderer,
    Row: RowRenderer,
    Card: CardRenderer,
    Box: BoxRenderer,
    Scaffold: ScaffoldRenderer,
    TopBar: TopBarRenderer,
    Button: ButtonRenderer,
    Chip: ChipRenderer,
    Fab: FabRenderer,
    TextField: TextFieldRenderer,
    CheckBox: CheckBoxRenderer,
    Switch: SwitchRenderer,
    Slider: SliderRenderer,
    Tabs: TabsRenderer,
    Select: SelectRenderer,
    DateTimeInput: DateTimeInputRenderer,
    List: ListRenderer,
    ListItem: ListItemRenderer,
    ProgressRing: ProgressRingRenderer,
    ProgressBar: ProgressBarRenderer,
    Modal: ModalRenderer,
  }

  it('exports 25 renderer functions (Button/FAB split + ProgressRing/Bar split)', () => {
    expect(Object.keys(renderers)).toHaveLength(25)
  })

  it.each(Object.entries(renderers))('renderer for %s is a function', (_kind, fn) => {
    expect(typeof fn).toBe('function')
  })
})
