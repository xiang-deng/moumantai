package com.moumantai.wear.renderer

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Per-face form-scope writer (mirrors Android client's `LocalFormSetter`).
 *
 * Inputs without an `action` (TextField, Slider in form mode, Switch in form
 * mode, etc.) write user-typed/dragged values here on change. The caller —
 * `AppViewModel` — routes the write to the currently active face's `form`
 * map. Survives face refreshes; cleared on navigation.
 *
 * The dispatcher reads from the same map at action-fire time, substituting
 * `pathRef('/$form/<key>')` placeholders against it.
 */
val LocalFormSetter = staticCompositionLocalOf<(key: String, value: Any?) -> Unit> {
    { _, _ ->
        // No-op fallback for tests rendered outside an AppPager. Inputs become
        // read-only in that case, which is fine for snapshots.
    }
}
