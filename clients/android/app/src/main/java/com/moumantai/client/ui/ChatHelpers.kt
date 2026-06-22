package com.moumantai.client.ui

/**
 * Pure utility functions for the chat UI.
 *
 * These are extracted from composables so they can be unit-tested without
 * Android instrumentation or Compose test rules.
 */

/**
 * Format an ISO-8601 timestamp string into a short time-only display.
 *
 * Extracts "HH:MM" from timestamps like "2026-03-22T14:30:00Z" or
 * "2026-03-22T14:30:00.000Z". Falls back to the raw string if it
 * doesn't match the expected format.
 */
fun formatChatTimestamp(iso: String): String {
    // Match ISO timestamps: look for Thh:mm in the string
    val timeRegex = Regex("""T(\d{2}:\d{2})""")
    val match = timeRegex.find(iso)
    return match?.groupValues?.get(1) ?: iso
}

/**
 * Whether a chat message role represents the user (right-aligned bubble).
 */
fun isUserRole(role: String): Boolean = role == "user"

/**
 * Whether a chat message role represents the assistant (left-aligned bubble).
 *
 * `system` role is grouped with `assistant` deliberately: system notices
 * (e.g. "conversation reset") are not filtered out, and they share the
 * left-aligned, non-user visual styling rather than getting their own
 * dedicated style. No special case beyond this alignment choice.
 */
fun isAssistantRole(role: String): Boolean = role == "assistant" || role == "system"
