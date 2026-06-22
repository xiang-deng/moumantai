package com.moumantai.wear.state

import com.moumantai.protocol.v1.ComponentDef

/**
 * UI state for a single face (one vertical page within an app).
 * Component trees and resolved data arrive via `FaceUpdateMsg` and are stored here.
 */
data class FaceState(
    val faceId: String,
    val label: String = "",
    val position: Int = 0,
    val components: Map<String, ComponentDef> = emptyMap(),
    val data: Map<String, Any?> = emptyMap(),
    /**
     * Per-face form scope. Inputs without an `action` write user-typed
     * values here on change. Survives `FaceUpdateMsg` broadcasts (server
     * never authors `$form`); cleared when the user navigates away from
     * the face. Action `args` reference values via `pathRef('/$form/<id>')`
     * which the dispatcher resolves at send time.
     */
    val form: Map<String, Any?> = emptyMap(),
)

/**
 * State for an installed app (one horizontal page in the pager).
 * Contains one or more [FaceState] objects for its vertical pages.
 */
data class AppState(
    val appId: String,
    val label: String = "",
    val icon: String = "",
    val position: Int = 0,
    val faces: List<FaceState> = emptyList(),
    val activeFaceIndex: Int = 0,
)
