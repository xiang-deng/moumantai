package com.moumantai.client.renderer

import androidx.compose.ui.Alignment
import com.moumantai.client.renderer.renderers.parseAlignment
import com.moumantai.protocol.v1.BoxComponent
import com.moumantai.protocol.v1.ButtonComponent
import com.moumantai.protocol.v1.CardComponent
import com.moumantai.protocol.v1.CheckBoxComponent
import com.moumantai.protocol.v1.ChipComponent
import com.moumantai.protocol.v1.ColumnComponent
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.DateTimeInputComponent
import com.moumantai.protocol.v1.DividerComponent
import com.moumantai.protocol.v1.DynamicBool
import com.moumantai.protocol.v1.DynamicDouble
import com.moumantai.protocol.v1.DynamicInt32
import com.moumantai.protocol.v1.DynamicString
import com.moumantai.protocol.v1.FabComponent
import com.moumantai.protocol.v1.IconComponent
import com.moumantai.protocol.v1.ImageComponent
import com.moumantai.protocol.v1.ListComponent
import com.moumantai.protocol.v1.ListItemComponent
import com.moumantai.protocol.v1.ModalComponent
import com.moumantai.protocol.v1.ProgressBarComponent
import com.moumantai.protocol.v1.ProgressRingComponent
import com.moumantai.protocol.v1.RowComponent
import com.moumantai.protocol.v1.ScaffoldComponent
import com.moumantai.protocol.v1.SelectComponent
import com.moumantai.protocol.v1.SliderComponent
import com.moumantai.protocol.v1.SwitchComponent
import com.moumantai.protocol.v1.TabsComponent
import com.moumantai.protocol.v1.TextComponent
import com.moumantai.protocol.v1.TextFieldComponent
import com.moumantai.protocol.v1.TopBarComponent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.moumantai.protocol.v1.Modifier as WireModifier

/**
 * Tests for the renderer's typed-proto pipeline:
 *   - dynamic-value resolution (DynamicString/Bool/Int32/Double + JSON-Pointer paths)
 *   - JSON-Pointer absolute-path navigation through nested maps + lists
 *   - the ComponentDef.modifier() variant lookup (covers all 23 component variants
 *     for the renderer dispatch — see [coversEvery23ComponentVariant])
 */
class RenderNodeTest {
    // -----------------------------------------------------------------------
    // resolveDynamic — DynamicString
    // -----------------------------------------------------------------------

    private val emptyData = emptyMap<String, Any?>()

    @Test
    fun `DynamicString literal returns the literal`() {
        assertEquals("hello", resolveDynamic(DynamicString(literal = "hello"), emptyData, null))
    }

    @Test
    fun `DynamicString null input returns null`() {
        assertNull(resolveDynamic(null as DynamicString?, emptyData, null))
    }

    @Test
    fun `DynamicString absolute path resolves from data model`() {
        val data = mapOf<String, Any?>("user" to mapOf<String, Any?>("name" to "Alice"))
        assertEquals("Alice", resolveDynamic(DynamicString(path = "/user/name"), data, null))
    }

    @Test
    fun `DynamicString nested absolute path resolves through arrays`() {
        val data =
            mapOf<String, Any?>(
                "items" to
                    listOf(
                        mapOf<String, Any?>("title" to "First"),
                        mapOf<String, Any?>("title" to "Second"),
                    ),
            )
        assertEquals("Second", resolveDynamic(DynamicString(path = "/items/1/title"), data, null))
    }

    @Test
    fun `DynamicString missing absolute path returns null`() {
        assertNull(resolveDynamic(DynamicString(path = "/nonexistent"), emptyData, null))
    }

    @Test
    fun `DynamicString item-scope dollar prefix resolves field`() {
        val itemScope = mapOf<String, Any?>("name" to "Groceries")
        assertEquals(
            "Groceries",
            resolveDynamic(DynamicString(path = "$.name"), emptyData, itemScope),
        )
    }

    @Test
    fun `DynamicString item-scope path with no scope returns null`() {
        assertNull(resolveDynamic(DynamicString(path = "$.field"), emptyData, null))
    }

    // -----------------------------------------------------------------------
    // resolveDynamic — DynamicBool
    // -----------------------------------------------------------------------

    @Test
    fun `DynamicBool literal returns the literal`() {
        assertTrue(resolveDynamic(DynamicBool(literal = true), emptyData, null))
    }

    @Test
    fun `DynamicBool null returns default`() {
        assertEquals(false, resolveDynamic(null as DynamicBool?, emptyData, null))
        assertEquals(true, resolveDynamic(null as DynamicBool?, emptyData, null, default = true))
    }

    @Test
    fun `DynamicBool path coerces string`() {
        val data = mapOf<String, Any?>("flag" to "true")
        assertTrue(resolveDynamic(DynamicBool(path = "/flag"), data, null))
    }

    @Test
    fun `DynamicBool path missing falls back to default`() {
        assertEquals(
            true,
            resolveDynamic(DynamicBool(path = "/missing"), emptyData, null, default = true),
        )
    }

    // -----------------------------------------------------------------------
    // resolveDynamic — DynamicInt32 / DynamicDouble
    // -----------------------------------------------------------------------

    @Test
    fun `DynamicInt32 path coerces numeric string`() {
        val data = mapOf<String, Any?>("count" to "42")
        assertEquals(42, resolveDynamic(DynamicInt32(path = "/count"), data, null))
    }

    @Test
    fun `DynamicInt32 path returns default for non-numeric value`() {
        val data = mapOf<String, Any?>("v" to "abc")
        assertEquals(7, resolveDynamic(DynamicInt32(path = "/v"), data, null, default = 7))
    }

    @Test
    fun `DynamicDouble path coerces number`() {
        val data = mapOf<String, Any?>("amount" to 3.14)
        assertEquals(
            3.14,
            resolveDynamic(DynamicDouble(path = "/amount"), data, null),
            0.0001,
        )
    }

    @Test
    fun `DynamicDouble null returns default`() {
        assertEquals(
            5.0,
            resolveDynamic(null as DynamicDouble?, emptyData, null, default = 5.0),
            0.0001,
        )
    }

    // -----------------------------------------------------------------------
    // resolveAbsolutePath
    // -----------------------------------------------------------------------

    @Test
    fun `resolveAbsolutePath returns root for empty pointer`() {
        val data = mapOf<String, Any?>("key" to "value")
        assertEquals(data, resolveAbsolutePath("", data))
        assertEquals(data, resolveAbsolutePath("/", data))
    }

    @Test
    fun `resolveAbsolutePath navigates nested maps`() {
        val data =
            mapOf<String, Any?>(
                "a" to mapOf<String, Any?>("b" to mapOf<String, Any?>("c" to "deep")),
            )
        assertEquals("deep", resolveAbsolutePath("/a/b/c", data))
    }

    @Test
    fun `resolveAbsolutePath navigates arrays by index`() {
        val data = mapOf<String, Any?>("items" to listOf("zero", "one", "two"))
        assertEquals("one", resolveAbsolutePath("/items/1", data))
    }

    @Test
    fun `resolveAbsolutePath returns null for out of bounds index`() {
        val data = mapOf<String, Any?>("items" to listOf("only"))
        assertNull(resolveAbsolutePath("/items/5", data))
    }

    @Test
    fun `resolveAbsolutePath handles tilde escaping`() {
        // RFC 6901: ~0 = ~, ~1 = /
        val data = mapOf<String, Any?>("a/b" to "slash", "a~b" to "tilde")
        assertEquals("slash", resolveAbsolutePath("/a~1b", data))
        assertEquals("tilde", resolveAbsolutePath("/a~0b", data))
    }

    // -----------------------------------------------------------------------
    // ComponentDef.modifier() — exhaustiveness over the ComponentDef oneof.
    // If a new variant lands without a matching branch in renderer/RenderNode.kt,
    // this test fails.
    // -----------------------------------------------------------------------

    @Test
    fun `coversEveryComponentVariant`() {
        val mod = WireModifier()
        val variants: List<ComponentDef> =
            listOf(
                ComponentDef(id = "1", text = TextComponent(modifier = mod)),
                ComponentDef(id = "2", icon = IconComponent(modifier = mod)),
                ComponentDef(id = "3", image = ImageComponent(modifier = mod)),
                ComponentDef(id = "4", divider = DividerComponent(modifier = mod)),
                ComponentDef(id = "5", column = ColumnComponent(modifier = mod)),
                ComponentDef(id = "6", row = RowComponent(modifier = mod)),
                ComponentDef(id = "7", card = CardComponent(modifier = mod)),
                ComponentDef(id = "8", scaffold = ScaffoldComponent(modifier = mod)),
                ComponentDef(id = "9", top_bar = TopBarComponent(modifier = mod)),
                ComponentDef(id = "10", button = ButtonComponent(modifier = mod)),
                ComponentDef(id = "11", chip = ChipComponent(modifier = mod)),
                ComponentDef(id = "12", fab = FabComponent(modifier = mod)),
                ComponentDef(id = "13", text_field = TextFieldComponent(modifier = mod)),
                ComponentDef(id = "14", check_box = CheckBoxComponent(modifier = mod)),
                ComponentDef(id = "15", switch_toggle = SwitchComponent(modifier = mod)),
                ComponentDef(id = "16", slider = SliderComponent(modifier = mod)),
                ComponentDef(id = "17", tabs = TabsComponent(modifier = mod)),
                ComponentDef(id = "18", select = SelectComponent(modifier = mod)),
                ComponentDef(id = "19", date_time_input = DateTimeInputComponent(modifier = mod)),
                ComponentDef(id = "20", list = ListComponent(modifier = mod)),
                ComponentDef(id = "21", list_item = ListItemComponent(modifier = mod)),
                ComponentDef(id = "22", progress_ring = ProgressRingComponent(modifier = mod)),
                ComponentDef(id = "23", progress_bar = ProgressBarComponent(modifier = mod)),
                ComponentDef(id = "24", modal = ModalComponent(modifier = mod)),
                ComponentDef(id = "25", box = BoxComponent(modifier = mod)),
            )
        // Every variant must surface its modifier through the accessor.
        assertEquals(25, variants.size)
        for (v in variants) {
            assertEquals(
                "variant ${v.id} should expose its modifier slot via ComponentDef.modifier()",
                mod,
                v.modifier(),
            )
        }
    }

    // -----------------------------------------------------------------------
    // parseAlignment — Box maps the 9 design-system alignment strings to
    // Compose Alignment constants. Unknown strings fall back to topStart so
    // an LLM-introduced value never crashes the renderer.
    // -----------------------------------------------------------------------

    @Test
    fun `parseAlignment maps every design-system alignment string`() {
        assertEquals(Alignment.TopStart, parseAlignment("topStart"))
        assertEquals(Alignment.TopCenter, parseAlignment("topCenter"))
        assertEquals(Alignment.TopEnd, parseAlignment("topEnd"))
        assertEquals(Alignment.CenterStart, parseAlignment("centerStart"))
        assertEquals(Alignment.Center, parseAlignment("center"))
        assertEquals(Alignment.CenterEnd, parseAlignment("centerEnd"))
        assertEquals(Alignment.BottomStart, parseAlignment("bottomStart"))
        assertEquals(Alignment.BottomCenter, parseAlignment("bottomCenter"))
        assertEquals(Alignment.BottomEnd, parseAlignment("bottomEnd"))
    }

    @Test
    fun `parseAlignment falls back to topStart for unknown values`() {
        assertEquals(Alignment.TopStart, parseAlignment(""))
        assertEquals(Alignment.TopStart, parseAlignment("middleMiddle"))
        assertEquals(Alignment.TopStart, parseAlignment("BOTTOMEND"))
    }
}
