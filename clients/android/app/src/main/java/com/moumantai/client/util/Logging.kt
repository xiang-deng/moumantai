package com.moumantai.client.util

/** Log a warning safely -- no-op if android.util.Log is unavailable (e.g., in unit tests). */
internal fun safeLog(
    tag: String,
    msg: String,
    e: Throwable? = null,
) {
    try {
        if (e != null) {
            android.util.Log.w(tag, msg, e)
        } else {
            android.util.Log.w(tag, msg)
        }
    } catch (_: Throwable) {
    }
}
