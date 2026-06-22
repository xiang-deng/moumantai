plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
    // Wire generates Kotlin bindings from shared/protocol/proto/. Wire 4.x+
    // does NOT transitively apply the Kotlin Gradle plugin, so this is a pure pin.
    id("com.squareup.wire") version "5.1.0" apply false
    // Kotlin formatting via ktlint (resolved from Maven Central).
    id("com.diffplug.spotless") version "7.2.1" apply false
}
