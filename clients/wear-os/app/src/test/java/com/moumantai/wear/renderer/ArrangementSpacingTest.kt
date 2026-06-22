package com.moumantai.wear.renderer

import androidx.compose.foundation.layout.Arrangement
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Pins the catalog contract: `spacing` and `*_arrangement` compose, they are
 * NOT mutually exclusive. Web (CSS `gap` + `justify-content`) and ESP32
 * (`lv_obj_set_style_pad_gap` + flex main-axis alignment) treat them as
 * orthogonal; Compose's pre-composed `Arrangement.Center` etc. drop spacing,
 * so the mapper must use `Arrangement.spacedBy(dp, Alignment)` when both are
 * set.
 *
 * Identity check is the cleanest way to express this without a Compose
 * harness: pure singletons (Center, Start, End, ...) are `===`-equal to the
 * `Arrangement.<X>` object; `spacedBy(dp, Alignment)` returns a fresh
 * instance that is NOT identity-equal to the singleton.
 */
class ArrangementSpacingTest {

    @Test
    fun `horizontal center with no spacing returns the Center singleton`() {
        assertSame(Arrangement.Center, mapHorizontalArrangement("center", 0))
    }

    @Test
    fun `horizontal center with spacing returns a spacedBy combo (NOT the Center singleton)`() {
        val arr = mapHorizontalArrangement("center", 8)
        assertNotSame("spacing was dropped — see WearStyleHelpers.mapHorizontalArrangement", Arrangement.Center, arr)
    }

    @Test
    fun `horizontal end with spacing returns a spacedBy combo (NOT the End singleton)`() {
        assertNotSame(Arrangement.End, mapHorizontalArrangement("end", 6))
    }

    @Test
    fun `horizontal spaceBetween ignores spacing intentionally (distribution owns gaps)`() {
        // SpaceBetween / SpaceAround / SpaceEvenly compute their own gaps;
        // explicit spacing is dropped on purpose so they stay distribution-pure.
        assertSame(Arrangement.SpaceBetween, mapHorizontalArrangement("spaceBetween", 12))
    }

    @Test
    fun `null arrangement with no spacing falls back to Start`() {
        assertSame(Arrangement.Start, mapHorizontalArrangement(null, 0))
    }

    @Test
    fun `vertical center with spacing returns a spacedBy combo (NOT the Center singleton)`() {
        val arr = mapVerticalArrangement("center", 4)
        assertNotSame(Arrangement.Center, arr)
    }

    @Test
    fun `vertical top with no spacing returns the Top singleton`() {
        assertSame(Arrangement.Top, mapVerticalArrangement("top", 0))
    }
}
