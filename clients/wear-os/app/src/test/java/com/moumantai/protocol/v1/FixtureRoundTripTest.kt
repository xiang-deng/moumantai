package com.moumantai.protocol.v1

import com.squareup.wire.ProtoAdapter
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Cross-language fixture round-trip — Kotlin leg.
 *
 * For every entry in `shared/protocol/fixtures/fixtures.spec.json`, this
 * test:
 *
 *   1. Reads the canonical TS-produced wire bytes (`<fixture>.ts.bin`).
 *   2. Decodes them via Wire's `ProtoAdapter`.
 *   3. Re-encodes through the same adapter.
 *   4. Asserts the re-encoded bytes are byte-identical to the input.
 *   5. Writes the re-encoded bytes to `<fixture>.kotlin.bin` for the
 *      orchestrator to diff against the C output.
 *
 * Run via:
 *   ./gradlew :app:testDebugUnitTest --tests "com.moumantai.protocol.v1.FixtureRoundTripTest"
 *
 * The orchestrator (`scripts/test-cross-language.py`) drives this through
 * `task protocol:test-cross-language`.
 */
class FixtureRoundTripTest {

    @Test
    fun roundTripEveryFixture() {
        val repoRoot = repoRoot()
        val fixturesDir = File(repoRoot, "shared/protocol/fixtures")
        val spec = parseSpec(File(fixturesDir, "fixtures.spec.json"))

        val errors = mutableListOf<String>()
        var count = 0

        for (entry in spec) {
            val dir = File(fixturesDir, entry.dir)
            if (!dir.isDirectory) {
                errors += "fixture dir missing: ${dir.path}"
                continue
            }
            val adapter = adapterFor(entry.message)
            for (json in dir.listFiles { f -> f.extension == "json" && f.name != "fixtures.spec.json" }!!.sortedBy { it.name }) {
                val tsBin = File(dir, json.nameWithoutExtension + ".ts.bin")
                if (!tsBin.exists()) {
                    errors += "${entry.dir}/${json.name}: missing .ts.bin (run TS leg first)"
                    continue
                }
                val original = tsBin.readBytes()
                try {
                    val decoded = adapter.decode(original)
                    @Suppress("UNCHECKED_CAST")
                    val reencoded = (adapter as ProtoAdapter<Any>).encode(decoded as Any)
                    assertArrayEquals(
                        "${entry.dir}/${json.name}: re-encode bytes diverged from TS canonical",
                        original,
                        reencoded
                    )
                    File(dir, json.nameWithoutExtension + ".kotlin.bin").writeBytes(reencoded)
                    count++
                } catch (t: Throwable) {
                    errors += "${entry.dir}/${json.name}: ${t.message}"
                }
            }
        }

        if (errors.isNotEmpty()) {
            fail("Cross-language round-trip failed (${errors.size} errors):\n" + errors.joinToString("\n  ", prefix = "  "))
        }
        println("ok: round-tripped $count fixtures (Wire/Kotlin bindings)")
    }

    /** Walk up from CWD until we find the repo's `package.json` (acts as a sentinel). */
    private fun repoRoot(): File {
        var dir = File(".").canonicalFile
        while (true) {
            if (File(dir, "package.json").exists() && File(dir, "Taskfile.yml").exists()) {
                return dir
            }
            val parent = dir.parentFile ?: throw IllegalStateException(
                "could not find repo root walking up from ${File(".").canonicalPath}"
            )
            dir = parent
        }
    }

    /** Resolve a message-type string (e.g. "ClientHello") to its Wire ProtoAdapter. */
    private fun adapterFor(messageName: String): ProtoAdapter<*> = when (messageName) {
        "ClientHello" -> ClientHello.ADAPTER
        "ServerHello" -> ServerHello.ADAPTER
        "ErrorMessage" -> ErrorMessage.ADAPTER
        "ChatMessage" -> ChatMessage.ADAPTER
        "VoiceState" -> VoiceState.ADAPTER
        "AudioChunkHeader" -> AudioChunkHeader.ADAPTER
        "ImageChunkHeader" -> ImageChunkHeader.ADAPTER
        "NavigateMsg" -> NavigateMsg.ADAPTER
        "ViewingMsg" -> ViewingMsg.ADAPTER
        "ResetConversationMsg" -> ResetConversationMsg.ADAPTER
        "FaceUpdateMsg" -> FaceUpdateMsg.ADAPTER
        "FetchOlderMsg" -> FetchOlderMsg.ADAPTER
        "ChatHistoryMsg" -> ChatHistoryMsg.ADAPTER
        else -> error("unknown fixture message type: $messageName")
    }

    private data class FixtureSpec(val dir: String, val message: String)

    /** Tiny hand-rolled spec parser — avoids pulling kotlinx-serialization into
     *  the Wire test classpath. The spec file is a fixed shape we control. */
    private fun parseSpec(specFile: File): List<FixtureSpec> {
        val text = specFile.readText()
        val out = mutableListOf<FixtureSpec>()
        // Match `"dir": "..."` and `"message": "..."` pairs in source order.
        val regex = Regex("""\{\s*"dir"\s*:\s*"([^"]+)"\s*,\s*"message"\s*:\s*"([^"]+)"""")
        for (m in regex.findAll(text)) {
            out += FixtureSpec(m.groupValues[1], m.groupValues[2])
        }
        if (out.isEmpty()) error("no fixtures parsed from $specFile")
        return out
    }
}
