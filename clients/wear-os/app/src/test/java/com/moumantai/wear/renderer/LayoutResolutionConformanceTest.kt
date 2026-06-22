package com.moumantai.wear.renderer

import com.moumantai.protocol.designsystem.Layout
import com.moumantai.protocol.designsystem.LayoutSizeResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Cross-renderer conformance: drives the generated Kotlin resolver from the
 * shared fixture (Wear leg). Mirrors the Android test exactly — both
 * consume the same shared/protocol/design-system/generated/DesignSystem.kt
 * and assert identical results. The duplicated test ensures the wear-os
 * Gradle module wires the design-system codegen src dir correctly.
 *
 * See `shared/protocol/spec.md` rule 10.
 */
class LayoutResolutionConformanceTest {

    @Test
    fun `resolveChildWidth and resolveChildHeight match fixture for every case`() {
        val fixture = loadFixture()

        @Suppress("UNCHECKED_CAST")
        val rawCases = fixture["cases"] as List<Map<String, Any?>>
        val cases = rawCases.filter { it.containsKey("name") }

        for (case in cases) {
            val name = case["name"] as String
            val parentKind = case["parent_kind"] as String?
            val slotIndex = (case["slot_index"] as Number).toInt()
            val slotName = case["slot_name"] as String?
            val childKind = case["child_kind"] as String
            val childVariant = case["child_variant"] as String?
            val ownWidthKeyword = case["own_width_keyword"] as String?
            val ownHeightKeyword = case["own_height_keyword"] as String?
            val expectedWidth = case["expected_width"] as String
            val expectedHeight = case["expected_height"] as String

            val w = Layout.resolveChildWidth(
                parentKind,
                slotIndex,
                slotName,
                childKind,
                childVariant,
                ownWidthKeyword,
            )
            val h = Layout.resolveChildHeight(
                parentKind,
                slotIndex,
                slotName,
                childKind,
                childVariant,
                ownHeightKeyword,
            )
            assertEquals("[$name] width", expectedWidth, w.toFixtureString())
            assertEquals("[$name] height", expectedHeight, h.toFixtureString())
        }
    }

    private fun loadFixture(): Map<String, Any?> {
        val candidates = listOf(
            "../../shared/protocol/fixtures/layout-resolution/spec.json",
            "../../../shared/protocol/fixtures/layout-resolution/spec.json",
        )
        val file = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("layout-resolution fixture not found in any of: $candidates (cwd=${File("").absolutePath})")
        @Suppress("UNCHECKED_CAST")
        return Json.parseToJsonElement(file.readText()).jsonObject.toAny() as Map<String, Any?>
    }
}

private fun LayoutSizeResult.toFixtureString(): String = when (this) {
    LayoutSizeResult.FILL -> "fill"
    LayoutSizeResult.WRAP -> "wrap"
    LayoutSizeResult.FIXED -> "fixed"
    LayoutSizeResult.GROW -> "grow"
}

private fun JsonElement.toAny(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> mapValues { it.value.toAny() }
    is JsonArray -> map { it.toAny() }
    is JsonPrimitive -> when {
        isString -> contentOrNull
        else -> booleanOrNull ?: intOrNull ?: error("invalid primitive: $content")
    }
}
