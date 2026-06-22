package com.moumantai.wear.transport

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * JVM unit tests for [OfflineQueue].
 *
 * Uses a pure-JVM DataStore rooted under [TemporaryFolder] so the test
 * can run off-device. The transport is replaced with a [FakeTransport]
 * that records every call — we assert on those recordings rather than
 * on implementation details.
 */
class OfflineQueueTest {

    @get:Rule val tmp = TemporaryFolder()

    private lateinit var scope: CoroutineScope
    private lateinit var dataStore: DataStore<Preferences>
    private lateinit var queue: OfflineQueue
    private lateinit var filesDir: File

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val prefsFile = tmp.newFile("offline_queue.preferences_pb")
        dataStore = PreferenceDataStoreFactory.create(scope = scope) { prefsFile }
        filesDir = tmp.newFolder("files")
        queue = OfflineQueue(dataStore = dataStore, filesDir = filesDir)
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun `flushOnConnect drains enqueued text items in FIFO order`() = runTest {
        val transport = FakeTransport()
        repeat(5) { i ->
            queue.enqueueText(
                scope = "home",
                text = "msg-$i",
                clientMsgId = "cid-$i",
            )
        }

        queue.flushOnConnect(transport)

        assertEquals(5, transport.chatInputs.size)
        transport.chatInputs.forEachIndexed { i, call ->
            assertEquals("msg-$i", call.text)
            assertEquals("cid-$i", call.clientMsgId)
            assertEquals("home", call.scope)
        }
        // Queue should be drained.
        assertTrue(queue.peek().isEmpty())
    }

    @Test
    fun `enqueue beyond cap drops oldest and preserves the last 16`() = runTest {
        val transport = FakeTransport()
        repeat(20) { i ->
            queue.enqueueText(
                scope = "home",
                text = "msg-$i",
                clientMsgId = "cid-$i",
            )
        }

        // Queue should hold exactly 16 entries.
        assertEquals(16, queue.peek().size)

        queue.flushOnConnect(transport)

        // Flush yields the last 16, i.e. msg-4..msg-19.
        assertEquals(16, transport.chatInputs.size)
        assertEquals("msg-4", transport.chatInputs.first().text)
        assertEquals("msg-19", transport.chatInputs.last().text)
    }

    @Test
    fun `originConversationId is preserved through enqueue and flush`() = runTest {
        // Stamp a conv id on enqueue; drain must pass it through verbatim
        // so the server can detect post-outage conversation advances.
        val transport = FakeTransport()
        queue.enqueueText(
            scope = "home",
            text = "pre-outage message",
            clientMsgId = "cid-a",
            originConversationId = "conv-archived",
        )
        queue.enqueueText(
            scope = "home",
            text = "fresh-field-omitted",
            clientMsgId = "cid-b",
            // no originConversationId — optional field, stays null
        )

        queue.flushOnConnect(transport)

        assertEquals("conv-archived", transport.chatInputs[0].originConversationId)
        assertEquals(null, transport.chatInputs[1].originConversationId)
    }

    @Test
    fun `pruneStale drops items whose originConversationId disagrees with the current one`() = runTest {
        queue.enqueueText("home", "stale", "cid-stale", originConversationId = "conv-old")
        queue.enqueueText("home", "fresh", "cid-fresh", originConversationId = "conv-new")
        queue.enqueueText("home", "no-conv-id", "cid-no-conv-id", originConversationId = null)
        queue.enqueueText("app:other", "other-stale", "cid-other", originConversationId = "conv-old")

        // Server tells us "home" is now on conv-new. Drop home items pinned
        // to conv-old; leave null-conv-id items alone; leave items
        // for OTHER scopes alone (their conv-id is independent).
        val dropped = queue.pruneStale("home", "conv-new")

        assertEquals(1, dropped)
        val remaining = queue.peek().map { it.clientMsgId }.toSet()
        assertEquals(setOf("cid-fresh", "cid-no-conv-id", "cid-other"), remaining)
    }

    @Test
    fun `pruneStale is a no-op when currentConversationId is empty`() = runTest {
        queue.enqueueText("home", "msg", "cid-1", originConversationId = "conv-old")
        val dropped = queue.pruneStale("home", "")
        assertEquals(0, dropped)
        assertEquals(1, queue.peek().size)
    }

    @Test
    fun `enqueueInvokeTool round-trips through flushOnConnect with same client_request_id and resolved args`() = runTest {
        val transport = FakeTransport()
        val args = mapOf<String, Any?>(
            "kcal" to 2200L,
            "label" to "Goal",
            "force" to true,
            "tags" to listOf("dinner", "savory"),
        )
        queue.enqueueInvokeTool(
            scope = "app:diet-tracker",
            toolName = "set_daily_goal",
            args = args,
            sourceFaceId = "goals",
            clientRequestId = "req-abc-123",
            originConversationId = "conv-xyz",
        )

        queue.flushOnConnect(transport)

        // Replayed once with the same client_request_id (server dedup uses it).
        assertEquals(1, transport.invokeTools.size)
        val call = transport.invokeTools[0]
        assertEquals("set_daily_goal", call.toolName)
        assertEquals("goals", call.sourceFaceId)
        assertEquals("req-abc-123", call.clientRequestId)
        // Args round-trip through JSON: scalars + lists preserved (numbers come
        // back as Long when whole; that's what the proto Struct wants too).
        assertEquals(2200L, call.args?.get("kcal"))
        assertEquals("Goal", call.args?.get("label"))
        assertEquals(true, call.args?.get("force"))
        assertEquals(listOf("dinner", "savory"), call.args?.get("tags"))
        // Queue drained.
        assertTrue(queue.peek().isEmpty())
    }

    @Test
    fun `enqueueInvokeTool with null args keeps the toolName but argsJson is null`() = runTest {
        val transport = FakeTransport()
        queue.enqueueInvokeTool(
            scope = "app:diet-tracker",
            toolName = "add_meal",
            args = null,
            sourceFaceId = "today",
            clientRequestId = "req-1",
        )

        queue.flushOnConnect(transport)

        assertEquals(1, transport.invokeTools.size)
        assertEquals("add_meal", transport.invokeTools[0].toolName)
        // args reconstituted as null (no JSON to parse).
        assertEquals(null, transport.invokeTools[0].args)
    }

    // ------------------------------------------------------------------
    // FakeTransport — records what was sent so the test can assert on it.
    // ------------------------------------------------------------------

    private class FakeTransport : Transport {
        data class ChatInputCall(
            val scope: String,
            val text: String,
            val clientMsgId: String?,
            val originConversationId: String? = null,
        )

        data class InvokeToolCall(
            val toolName: String,
            val args: Map<String, Any?>?,
            val sourceFaceId: String,
            val clientRequestId: String,
        )

        val chatInputs = mutableListOf<ChatInputCall>()
        val invokeTools = mutableListOf<InvokeToolCall>()

        override fun sendChatInput(
            scope: String,
            text: String,
            clientMsgId: String?,
            originConversationId: String?,
        ) {
            chatInputs += ChatInputCall(scope, text, clientMsgId, originConversationId)
        }

        // Unused in these tests — but the interface requires them.
        override var onChatMessage: ((com.moumantai.protocol.v1.ChatMessage) -> Unit)? = null
        override var onChatWindow: ((com.moumantai.protocol.v1.ChatWindowMsg) -> Unit)? = null
        override var onChatHistory: ((com.moumantai.protocol.v1.ChatHistoryMsg) -> Unit)? = null
        override var onChatUpdate: ((com.moumantai.protocol.v1.ChatUpdateMsg) -> Unit)? = null
        override var onResetNotice: ((com.moumantai.protocol.v1.ResetNoticeMsg) -> Unit)? = null
        override var onVoiceState: ((com.moumantai.protocol.v1.VoiceState) -> Unit)? = null
        override var onAppList: ((com.moumantai.protocol.v1.AppListMsg) -> Unit)? = null
        override var onFaceList: ((com.moumantai.protocol.v1.FaceListMsg) -> Unit)? = null
        override var onFaceUpdate: ((com.moumantai.protocol.v1.FaceUpdateMsg) -> Unit)? = null
        override var onNavigate: ((com.moumantai.protocol.v1.NavigateMsg) -> Unit)? = null
        override var onAudioChunk: ((data: ByteArray, isFinal: Boolean, format: String, sampleRate: Int) -> Unit)? = null
        override var onConnectionState: ((Transport.ConnectionState) -> Unit)? = null
        override var onPairingRequired: ((code: String) -> Unit)? = null
        override var onServerHello: ((com.moumantai.protocol.v1.ServerHello) -> Unit)? = null
        override var onError: ((com.moumantai.protocol.v1.ErrorMessage) -> Unit)? = null
        override var onUiActionEscalated: ((com.moumantai.protocol.v1.UiActionEscalated) -> Unit)? = null
        override var navIntentProvider: (() -> NavIntent)? = null

        override val sessionId: String? = null

        override fun connect(
            deviceClass: String,
            width: Int,
            height: Int,
            deviceId: String,
        ) {}
        override fun disconnect() {}

        override fun setForeground(fg: Boolean) {}
        override fun sendFetchOlder(scope: String, beforeSeq: Long, limit: Int) {}
        override fun sendInvokeTool(
            toolName: String,
            args: Map<String, Any?>?,
            sourceFaceId: String,
            clientRequestId: String,
        ) {
            invokeTools += InvokeToolCall(toolName, args, sourceFaceId, clientRequestId)
        }
        override fun sendViewing(scope: String) {}
        override fun sendResetConversation(scope: String) {}
        override fun sendAudioInput(
            data: ByteArray,
            format: String,
            sampleRate: Int,
            final: Boolean,
            scope: String,
            clientMsgId: String?,
        ) {}

        override fun onHello(hello: com.moumantai.protocol.v1.ServerHello) {}
    }
}
