package com.moumantai.wear.renderer

/**
 * Typed action-dispatch lambda for renderers:
 *
 *     dispatch: (Action?, itemScope: Map<String, Any?>?) -> Unit
 *
 * Implemented by `AppViewModel.sendAction`, which resolves `{path: "..."}`
 * placeholders against face data + itemScope + `/$form/...`, generates a
 * fresh `client_request_id`, and forwards via `Transport.sendInvokeTool`.
 *
 * Mirrors `clients/android/.../ActionDispatcher.kt`.
 */
