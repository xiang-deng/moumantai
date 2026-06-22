package com.moumantai.client.renderer

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Per-face form-scope writer.
 *
 * Inputs without an `action` write user values here on change. The ViewModel
 * routes writes to the active face's `form` map; the dispatcher resolves
 * `pathRef('/\$form/<key>')` placeholders from it at action-fire time.
 * Survives face refreshes; cleared on navigation.
 *
 * Default is a no-op — AppPager provides a real implementation via
 * `CompositionLocalProvider`. The no-op makes inputs read-only in isolation
 * (unit tests), which is intentional.
 */
val LocalFormSetter =
    staticCompositionLocalOf<(key: String, value: Any?) -> Unit> {
        { _, _ -> }
    }

/**
 * HTTP base URL of the connected server (e.g. `http://10.0.2.2:3000`).
 * Renderers prepend this to root-relative asset paths (`/apps/<id>/assets/…`).
 * Empty string means no host known — relative URLs pass through to Coil
 * unchanged (harmless for tests that don't render images).
 */
val LocalServerHttpBase = staticCompositionLocalOf { "" }
