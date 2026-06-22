package com.moumantai.client.state

import com.moumantai.protocol.v1.ComponentDef

/**
 * Holds the current UI state for a single face within an app.
 *
 * A face is one vertical page within an app. The server sends component
 * trees and resolved data via `FaceUpdateMsg` which are stored here and
 * read by the renderer.
 *
 * Components arrive as Wire-typed `com.moumantai.protocol.v1.ComponentDef`
 * messages — the renderer dispatches on which oneof variant is set.
 */
data class FaceState(
    val faceId: String,
    val label: String = "",
    val position: Int = 0,
    val components: Map<String, ComponentDef> = emptyMap(),
    val data: Map<String, Any?> = emptyMap(),
    /**
     * Per-face form scope. Inputs without an `action` write user-typed values
     * here on change. Survives `FaceUpdateMsg` broadcasts (server never
     * authors `$form`); cleared when the user navigates away from the face.
     * Action `args` reference values via `pathRef('/$form/<id>')` which the
     * dispatcher resolves at send time.
     */
    val form: Map<String, Any?> = emptyMap(),
)

/**
 * Holds the current state for an installed app.
 *
 * An app is one horizontal page in the pager. Each app contains one or
 * more [FaceState] objects representing its vertical pages.
 */
data class AppState(
    val appId: String,
    val label: String = "",
    val icon: String = "",
    val position: Int = 0,
    val faces: List<FaceState> = emptyList(),
    val activeFaceIndex: Int = 0,
)
