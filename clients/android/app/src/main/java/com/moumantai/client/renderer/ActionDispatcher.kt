package com.moumantai.client.renderer

/**
 * Component actions are dispatched via a typed lambda passed to every renderer:
 *
 *     dispatch: (Action?, itemScope: Map<String, Any?>?) -> Unit
 *
 * The implementation is `AppViewModel.sendAction`, which resolves
 * `{path: "..."}` placeholders in `Action.args` against face data, itemScope,
 * and `/$form/...`, then forwards through `MoumantaiTransport.sendInvokeTool`.
 *
 * This file is a doc anchor — renderers call `dispatch(c.action, itemScope)` directly.
 */
