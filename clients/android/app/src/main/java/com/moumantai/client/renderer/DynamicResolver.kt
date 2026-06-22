package com.moumantai.client.renderer

import com.moumantai.protocol.v1.DynamicBool
import com.moumantai.protocol.v1.DynamicDouble
import com.moumantai.protocol.v1.DynamicInt32
import com.moumantai.protocol.v1.DynamicString

/**
 * Resolves Wire-typed dynamic values (DynamicString / DynamicBool /
 * DynamicInt32 / DynamicDouble) and JSON-Pointer paths against the surrounding
 * face data model.
 *
 * Each `Dynamic*` is a oneof of `literal` (use as-is) or `path` (resolve
 * against the data model). Paths come in two flavours:
 *  - Absolute: starts with "/" — resolved against root data model.
 *  - Item scope: starts with "$." — stripped to a field name and resolved
 *    against the current list item's scope.
 *  - Anything else without a "/" prefix — treated as relative key lookup
 *    against the item scope.
 */

/** Resolve a `DynamicString` to a Kotlin string, or null if unset/missing. */
fun resolveDynamic(
    d: DynamicString?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
): String? {
    if (d == null) return null
    d.literal?.let { return it }
    val p = d.path ?: return null
    val v = resolvePath(p, data, itemScope) ?: return null
    return v.toString()
}

/** Resolve a `DynamicBool` to a Kotlin boolean. */
fun resolveDynamic(
    d: DynamicBool?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    default: Boolean = false,
): Boolean {
    if (d == null) return default
    d.literal?.let { return it }
    val p = d.path ?: return default
    return when (val v = resolvePath(p, data, itemScope)) {
        is Boolean -> v
        is String -> v.toBooleanStrictOrNull() ?: default
        is Number -> v.toInt() != 0
        else -> default
    }
}

/** Resolve a `DynamicInt32` to a Kotlin int. */
fun resolveDynamic(
    d: DynamicInt32?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    default: Int = 0,
): Int {
    if (d == null) return default
    d.literal?.let { return it }
    val p = d.path ?: return default
    return when (val v = resolvePath(p, data, itemScope)) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull() ?: v.toDoubleOrNull()?.toInt() ?: default
        is Boolean -> if (v) 1 else 0
        else -> default
    }
}

/** Resolve a `DynamicDouble` to a Kotlin double. */
fun resolveDynamic(
    d: DynamicDouble?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    default: Double = 0.0,
): Double {
    if (d == null) return default
    d.literal?.let { return it }
    val p = d.path ?: return default
    return when (val v = resolvePath(p, data, itemScope)) {
        is Number -> v.toDouble()
        is String -> v.toDoubleOrNull() ?: default
        is Boolean -> if (v) 1.0 else 0.0
        else -> default
    }
}

/**
 * Resolve a path string against the data model, with item-scope fallback.
 * "/abs" goes through the root data model; "$.field" strips the prefix and
 * looks up `field` on `itemScope`; anything else is treated as a relative
 * key on the item scope.
 */
private fun resolvePath(
    path: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
): Any? = when {
    path.startsWith("/") -> resolveAbsolutePath(path, data)
    path.startsWith("$.") -> itemScope?.get(path.removePrefix("$."))
    else -> itemScope?.get(path)
}

/**
 * Navigate a JSON Pointer path (RFC 6901) through nested maps and lists.
 *
 * @param pointer A path like "/transactions/0/amount".
 * @param data The root data object.
 * @return The value at the pointer, or null if not found.
 */
fun resolveAbsolutePath(pointer: String, data: Any?): Any? {
    if (pointer.isEmpty() || pointer == "/") return data

    val parts = pointer.split("/").drop(1) // skip leading empty string from split
    var current: Any? = data

    for (part in parts) {
        if (current == null) return null

        val key = part.replace("~1", "/").replace("~0", "~")

        current = when (current) {
            is Map<*, *> -> current[key]
            is List<*> -> {
                val index = key.toIntOrNull() ?: return null
                if (index in current.indices) current[index] else null
            }
            else -> return null
        }
    }

    return current
}
