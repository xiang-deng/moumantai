plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.squareup.wire")
    id("com.diffplug.spotless")
}

android {
    namespace = "com.moumantai.client"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.moumantai.client"
        minSdk = 28
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
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
        freeCompilerArgs += listOf("-opt-in=androidx.compose.material3.ExperimentalMaterial3Api")
    }

    buildFeatures {
        compose = true
    }

    // Pull hand-written shared Kotlin (BinaryFrame, AudioPlayer, etc.) and
    // design-system codegen (DesignSystem.kt) from the cross-language SSOT.
    // Non-Kotlin siblings in the generated dir are ignored by the compiler.
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
// Source: ../../shared/protocol/proto/moumantai/v1/*.proto (package moumantai.v1).
// Output committed to git under src/main/java/moumantai/v1/*.kt.
// Regenerate via `task protocol:gen`; Wire-only: `./gradlew :app:generateProtos`.

wire {
    // The repo-root .proto SSOT.
    sourcePath {
        srcDir(rootProject.file("../../shared/protocol/proto"))
    }
    // Emit Kotlin under src/main/java/<proto-package-path>. With package
    // `moumantai.v1`, that resolves to src/main/java/moumantai/v1/*.kt.
    kotlin {
        out = "${projectDir}/src/main/java"
        android = true // AndroidX-aware codegen (Parcelable, Bundle support)
    }
}

// ---------------------------------------------------------------------------
// Spotless — Kotlin formatting via ktlint. Apply: `./gradlew :app:spotlessApply`;
// verify: `spotlessCheck`. Orchestrated by `task android:format`.
//
// Note: shared Kotlin under ../../shared/protocol/kotlin sits outside the
// project dir so Spotless cannot reach it; maintain by hand to match this style.
spotless {
    kotlin {
        target("src/**/*.kt")
        // Exclude codegen-owned trees (never hand-format — would drift gen-check):
        //   com/moumantai/protocol/  = Wire proto bindings
        //   **/generated/            = token codegen (CompactTokens/ExpandedTokens)
        targetExclude("**/com/moumantai/protocol/**", "**/generated/**")
        // Disable non-formatting rules that conflict with intentional idioms
        // (Compose PascalCase composables, ViewModel backing props, adjacent KDoc).
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

    // Compose
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Wire runtime (required by generated Kotlin protobuf bindings)
    implementation("com.squareup.wire:wire-runtime:5.1.0")

    // Image loading
    implementation("io.coil-kt:coil-compose:2.5.0")

    // DataStore (settings persistence)
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")

    // Instrumented testing (Compose UI + Espresso)
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.10.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")

    // CameraX
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
}
