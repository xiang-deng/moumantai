package com.moumantai.wear.renderer

import com.moumantai.wear.state.AppViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Cross-client conformance: drives Wear's action-resolver from the shared
 * fixture at `shared/protocol/fixtures/form-semantics/spec.json`.
 *
 * Asserts the client_resolver invariant: the dispatcher substitutes
 * `pathRef('/$form/<id>')` placeholders verbatim — no client-side coercion.
 *
 * Mirrors `clients/android/.../FormSemanticsConformanceTest.kt` against the
 * same fixture; both must pass against an unchanged contract.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FormSemanticsConformanceTest {

    private lateinit var vm: AppViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        vm = AppViewModel()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `client resolver substitutes form-scope values verbatim (no coercion)`() {
        val fixture = loadFixture()

        @Suppress("UNCHECKED_CAST")
        val resolverBlock = fixture["client_resolver"] as Map<String, Any?>

        @Suppress("UNCHECKED_CAST")
        val cases = resolverBlock["cases"] as List<Map<String, Any?>>

        for (case in cases) {
            val name = case["name"] as String

            @Suppress("UNCHECKED_CAST")
            val formState = case["form_state"] as Map<String, Any?>

            @Suppress("UNCHECKED_CAST")
            val actionArgs = case["action_args"] as Map<String, Any?>

            @Suppress("UNCHECKED_CAST")
            val expected = case["expected_wire_args"] as Map<String, Any?>

            val actual = vm.resolveActionArgs(
                args = actionArgs,
                faceData = emptyMap(),
                form = formState,
                itemScope = null,
            )
            assertEquals("[$name] resolved args mismatch", expected, actual)
        }
    }

    private fun loadFixture(): Map<String, Any?> {
        val candidates = listOf(
            "../../shared/protocol/fixtures/form-semantics/spec.json",
            "../../../shared/protocol/fixtures/form-semantics/spec.json",
        )
        val file = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("form-semantics fixture not found in any of: $candidates (cwd=${File("").absolutePath})")
        @Suppress("UNCHECKED_CAST")
        return Json.parseToJsonElement(file.readText()).jsonObject.toAny() as Map<String, Any?>
    }
}

// Numbers coerced to Double to match the dispatcher path's runtime types
// (mirrors the Android conformance test's helper).
private fun JsonElement.toAny(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> mapValues { it.value.toAny() }
    is JsonArray -> map { it.toAny() }
    is JsonPrimitive -> when {
        isString -> content
        else -> booleanOrNull ?: doubleOrNull ?: error("invalid primitive: $content")
    }
}
