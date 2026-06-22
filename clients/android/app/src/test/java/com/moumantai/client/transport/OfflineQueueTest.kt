package com.moumantai.client.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * JVM unit tests for [OfflineQueue]. Uses the `internal` File-based
 * constructor; production code goes through the Context overload.
 *
 * Mirrors `clients/wear-os/.../OfflineQueueTest`. Keep both in sync.
 */
class OfflineQueueTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var filesDir: File

    private fun newQueue(): OfflineQueue {
        filesDir = tmp.newFolder("files")
        return OfflineQueue(filesDir)
    }

    @Test
    fun `enqueueText preserves caller-supplied clientMsgId verbatim`() {
        // Regression: an earlier Android implementation generated its own UUID
        // inside enqueueText, diverging from the optimistic chat bubble's
        // clientMsgId and producing duplicate rows on drain. This asserts the
        // caller's id round-trips through enqueue → peek → drain.
        val queue = newQueue()
        val supplied =
            listOf(
                "550e8400-e29b-41d4-a716-446655440000",
                "abc-123",
                "id/with-special_chars",
            )
        supplied.forEachIndexed { i, id ->
            queue.enqueueText("home", "msg-$i", clientMsgId = id)
        }

        val ids = queue.peek().map { it.clientMsgId }
        assertEquals(supplied, ids)
        assertNotEquals(supplied[0], supplied[1])
    }

    @Test
    fun `drain visits items in FIFO order and clears the queue on success`() {
        val queue = newQueue()
        repeat(5) { i ->
            queue.enqueueText("home", "msg-$i", clientMsgId = "cid-$i")
        }

        val seen = mutableListOf<String>()
        queue.drain { item ->
            seen += item.clientMsgId
            true
        }

        assertEquals(listOf("cid-0", "cid-1", "cid-2", "cid-3", "cid-4"), seen)
        assertTrue(queue.peek().isEmpty())
    }

    @Test
    fun `drain stops on first failure and preserves order for retry`() {
        val queue = newQueue()
        repeat(4) { i ->
            queue.enqueueText("home", "msg-$i", clientMsgId = "cid-$i")
        }

        val seen = mutableListOf<String>()
        queue.drain { item ->
            seen += item.clientMsgId
            // Fail on the third item — drain should stop, leaving cid-2..cid-3 queued.
            item.clientMsgId != "cid-2"
        }

        assertEquals(listOf("cid-0", "cid-1", "cid-2"), seen)
        val remaining = queue.peek().map { it.clientMsgId }
        assertEquals(listOf("cid-2", "cid-3"), remaining)
    }

    @Test
    fun `enqueueInvokeTool round-trips with same client_request_id and resolved args`() {
        val queue = newQueue()
        val args =
            mapOf<String, Any?>(
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

        val items = queue.peek()
        assertEquals(1, items.size)
        val item = items[0]
        assertEquals("invoke_tool", item.kind)
        assertEquals("req-abc-123", item.clientMsgId)
        assertEquals("set_daily_goal", item.toolName)
        assertEquals("goals", item.sourceFaceId)
        assertEquals("conv-xyz", item.originConversationId)

        val decoded = queue.readInvokeToolArgs(item)!!
        assertEquals(2200L, decoded["kcal"])
        assertEquals("Goal", decoded["label"])
        assertEquals(true, decoded["force"])
        assertEquals(listOf("dinner", "savory"), decoded["tags"])
    }

    @Test
    fun `enqueueInvokeTool with null args yields no argsJson`() {
        val queue = newQueue()
        queue.enqueueInvokeTool(
            scope = "app:diet-tracker",
            toolName = "add_meal",
            args = null,
            sourceFaceId = "today",
            clientRequestId = "req-1",
        )

        val item = queue.peek().single()
        assertNull(item.argsJson)
        assertNull(queue.readInvokeToolArgs(item))
    }

    @Test
    fun `MAX_ITEMS overflow drops oldest entries and preserves the tail`() {
        val queue = newQueue()
        // MAX_ITEMS = 20 on Android. Push 25 → expect last 20 retained.
        repeat(25) { i ->
            queue.enqueueText("home", "msg-$i", clientMsgId = "cid-$i")
        }

        val items = queue.peek()
        assertEquals(20, items.size)
        // Oldest five evicted: cid-0..cid-4.
        assertEquals("cid-5", items.first().clientMsgId)
        assertEquals("cid-24", items.last().clientMsgId)
    }

    @Test
    fun `MAX_ITEMS overflow deletes voice blobs of evicted items`() {
        // Regression: a prior `trimAndWrite` truncated without deleting the
        // blob files of evicted voice items, leaking disk over time.
        val queue = newQueue()
        val voice = queue.enqueueVoice("home", pcm = ByteArray(8) { 0x42 })!!
        val blobFile = File(filesDir, voice.voiceBlobPath!!)
        assertTrue("blob should exist after enqueueVoice", blobFile.exists())

        // Push 24 text items so the voice item gets evicted past the 20-cap.
        repeat(24) { i ->
            queue.enqueueText("home", "msg-$i", clientMsgId = "cid-$i")
        }

        assertTrue(
            "voice item should be evicted from queue",
            queue.peek().none { it.kind == "voice" },
        )
        assertTrue(
            "evicted voice blob should be deleted from disk",
            !blobFile.exists(),
        )
    }
}
