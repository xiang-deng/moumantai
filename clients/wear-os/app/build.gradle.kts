plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.squareup.wire")
    id("com.diffplug.spotless")
}

android {
    // namespace stays `com.moumantai.wear`; applicationId matches the phone's
    // so Wear OS treats both APKs as the same logical Wear-pair app.
    namespace = "com.moumantai.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.moumantai.client"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        // Wear Compose Material 3 1.6+ inline functions (e.g. AppScaffold) are
        // built with JVM target 11 — mismatching produces a compile error.
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = "11"
    }

    buildFeatures {
        compose = true
    }

    // Pull shared hand-written Kotlin (BinaryFrame, AudioPlayer, etc.) and
    // design-system codegen (DesignSystem.kt) as srcDirs — no separate module.
    // Non-Kotlin siblings (.css/.ts/.h) in the generated dir are ignored.
    sourceSets {
        getByName("main") {
            java.srcDir(rootProject.file("../../shared/protocol/kotlin"))
            java.srcDir(rootProject.file("../../shared/protocol/design-system/generated"))
        }
    }
}

// ---------------------------------------------------------------------------
// Wire — generate Kotlin bindings from the shared .proto SSOT
// ---------------------------------------------------------------------------
//
// Source: ../../shared/protocol/proto/moumantai/v1/*.proto (package moumantai.v1).
// Output committed to git under src/main/java/moumantai/v1/*.kt.
// Regenerate via `task protocol:gen`; Wire-only: `./gradlew :app:generateProtos`.

wire {
    sourcePath {
        srcDir(rootProject.file("../../shared/protocol/proto"))
    }
    kotlin {
        out = "${projectDir}/src/main/java"
        android = true
    }
}

// ---------------------------------------------------------------------------
// Spotless — ktlint formatting (resolved from Maven Central).
// Apply: `./gradlew :app:spotlessApply`; verify: `spotlessCheck`.
// Orchestrated by `task wear-os:format` and the root `task format`.
// ---------------------------------------------------------------------------
spotless {
    kotlin {
        target("src/**/*.kt")
        // Exclude codegen: Wire bindings + design-system token files.
        targetExclude("**/com/moumantai/protocol/**", "**/generated/**")
        // Disable ktlint rules that conflict with Compose idioms (PascalCase
        // composables, ViewModel backing props, adjacent KDoc, empty anchor files).
        ktlint().editorConfigOverride(
            mapOf(
                "ktlint_standard_function-naming" to "disabled",
                "ktlint_standard_backing-property-naming" to "disabled",
                "ktlint_standard_no-consecutive-comments" to "disabled",
                "ktlint_standard_no-empty-file" to "disabled",
            ),
        )
    }
}

dependencies {
    // Kotlin
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.0.21")

    // Wear OS Compose — Material 3 (M2 `compose-material` is superseded).
    // Foundation + navigation pinned to the same minor (TransformingLazyColumn
    // lives in `androidx.wear.compose.foundation.lazy`).
    implementation("androidx.wear.compose:compose-material3:1.6.1")
    implementation("androidx.wear.compose:compose-foundation:1.6.1")
    implementation("androidx.wear.compose:compose-navigation:1.6.1")

    // Wear OS core
    implementation("androidx.wear:wear:1.3.0")

    // Compose (shared foundation)
    implementation(platform("androidx.compose:compose-bom:2024.01.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Wire runtime (required by generated Kotlin protobuf bindings)
    implementation("com.squareup.wire:wire-runtime:5.1.0")

    // Image loading
    implementation("io.coil-kt:coil-compose:2.5.0")

    // Wear OS text input (RemoteInput system UI)
    implementation("androidx.wear:wear-input:1.2.0-alpha02")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    // JVM-only DataStore for OfflineQueue unit tests (production artifact is Android-only).
    testImplementation("androidx.datastore:datastore-preferences-core:1.1.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.01.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
