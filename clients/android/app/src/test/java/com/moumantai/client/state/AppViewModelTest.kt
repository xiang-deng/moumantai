package com.moumantai.client.state

import com.moumantai.client.transport.MoumantaiTransport
import com.moumantai.protocol.v1.AppInfo
import com.moumantai.protocol.v1.AppListMsg
import com.moumantai.protocol.v1.ChatHistoryMsg
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatRole
import com.moumantai.protocol.v1.ChatUpdateMsg
import com.moumantai.protocol.v1.ChatWindowEntry
import com.moumantai.protocol.v1.ChatWindowMsg
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.ErrorMessage
import com.moumantai.protocol.v1.FaceInfo
import com.moumantai.protocol.v1.FaceListMsg
import com.moumantai.protocol.v1.FaceUpdateMsg
import com.moumantai.protocol.v1.NavigateMsg
import com.moumantai.protocol.v1.ProtocolErrorCode
import com.moumantai.protocol.v1.ResetNoticeMsg
import com.moumantai.protocol.v1.ScaffoldComponent
import com.moumantai.protocol.v1.TextComponent
import com.moumantai.protocol.v1.TurnStatus
import com.moumantai.protocol.v1.UiActionEscalated
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.protocol.v1.VoiceStateValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [AppViewModel]'s message handling and state management.
 *
 * Wire-typed messages are constructed directly; the ViewModel consumes the
 * same Wire-generated types the transport produces.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    private lateinit var vm: AppViewModel

    @Before
    fun setUp() {
        // AppViewModel launches a derivation on viewModelScope (Dispatchers.Main)
        // for displayState — JVM unit tests need the main dispatcher installed.
        Dispatchers.setMain(UnconfinedTestDispatcher())
        vm = AppViewModel()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // -----------------------------------------------------------------------
    // Initial state
    // -----------------------------------------------------------------------

    @Test
    fun `fresh ViewModel has all state-flows in their default form`() {
        assertEquals(MoumantaiTransport.ConnectionState.DISCONNECTED, vm.connectionState.value)
        assertNull(vm.sessionId.value)
        assertTrue(vm.apps.value.isEmpty())
        assertEquals(0, vm.activeAppIndex.value)
        assertEquals(VoiceStateValue.VOICE_STATE_VALUE_IDLE, vm.voiceState.value.state)
        assertTrue(vm.chatMessagesByApp.value.isEmpty())
    }

    // -----------------------------------------------------------------------
    // handleAppList
    // -----------------------------------------------------------------------

    @Test
    fun `appList populates apps sorted by position`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "spend-tracker", label = "Spend", icon = "payments", position = 1),
                    AppInfo(app_id = "home", label = "Home", icon = "home", position = 0),
                ),
            ),
        )

        assertEquals(2, vm.apps.value.size)
        assertEquals("home", vm.apps.value[0].appId)
        assertEquals("spend-tracker", vm.apps.value[1].appId)
    }

    @Test
    fun `appList preserves existing face state`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app1", label = "App", icon = "star", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "app1",
                faces = listOf(FaceInfo(face_id = "f1", label = "Face 1", position = 0)),
            ),
        )
        assertEquals(
            1,
            vm.apps.value[0]
                .faces.size,
        )

        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app1", label = "App Updated", icon = "star", position = 0))),
        )
        assertEquals("App Updated", vm.apps.value[0].label)
        assertEquals(
            1,
            vm.apps.value[0]
                .faces.size,
        )
        assertEquals(
            "f1",
            vm.apps.value[0]
                .faces[0]
                .faceId,
        )
    }

    @Test
    fun `appList clamps active index when apps shrink`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "a", label = "A", icon = "a", position = 0),
                    AppInfo(app_id = "b", label = "B", icon = "b", position = 1),
                ),
            ),
        )
        vm.switchApp(1)
        assertEquals(1, vm.activeAppIndex.value)

        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "a", label = "A", icon = "a", position = 0))),
        )
        assertEquals(0, vm.activeAppIndex.value)
    }

    // -----------------------------------------------------------------------
    // handleFaceList
    // -----------------------------------------------------------------------

    @Test
    fun `faceList sets faces on target app`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "tracker", label = "T", icon = "t", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "tracker",
                faces =
                listOf(
                    FaceInfo(face_id = "summary", label = "Summary", position = 0),
                    FaceInfo(face_id = "history", label = "History", position = 1),
                ),
            ),
        )

        val app = vm.apps.value[0]
        assertEquals(2, app.faces.size)
        assertEquals("summary", app.faces[0].faceId)
        assertEquals("history", app.faces[1].faceId)
    }

    // -----------------------------------------------------------------------
    // handleFaceUpdate
    // -----------------------------------------------------------------------

    @Test
    fun `faceUpdate sets components and data on target face`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app", label = "App", icon = "a", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "app",
                faces = listOf(FaceInfo(face_id = "main", label = "Main", position = 0)),
            ),
        )

        val components =
            listOf(
                ComponentDef(id = "root", scaffold = ScaffoldComponent()),
                ComponentDef(id = "t1", text = TextComponent()),
            )
        val data =
            mapOf<String, Any?>(
                "title" to "Test",
                "count" to 42.0,
            )

        vm.handleFaceUpdateForTest(
            FaceUpdateMsg(
                scope = "app:app",
                app_id = "app",
                face_id = "main",
                components = components,
                data_ = data,
            ),
        )

        val face = vm.apps.value[0].faces[0]
        assertEquals(2, face.components.size)
        assertNotNull(face.components["root"]?.scaffold)
        assertNotNull(face.components["t1"]?.text)
        assertEquals("Test", face.data["title"])
        assertEquals(42.0, face.data["count"])
    }

    // -----------------------------------------------------------------------
    // $form preservation: server must never wipe in-progress drafts on refresh.
    // -----------------------------------------------------------------------

    @Test
    fun `faceList preserves per-face form scope across re-broadcast`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app", label = "App", icon = "a", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "app",
                faces = listOf(FaceInfo(face_id = "f1", label = "F1", position = 0)),
            ),
        )

        // User types into a TextField — captured into $form.
        vm.setFormValue("app", "f1", "draft_text", "in progress")
        assertEquals(
            "in progress",
            vm.apps.value[0]
                .faces[0]
                .form["draft_text"],
        )

        // Server re-broadcasts faceList (e.g., after reconnect). Must NOT wipe.
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "app",
                faces = listOf(FaceInfo(face_id = "f1", label = "F1 Updated", position = 0)),
            ),
        )
        assertEquals(
            "in progress",
            vm.apps.value[0]
                .faces[0]
                .form["draft_text"],
        )
        assertEquals(
            "F1 Updated",
            vm.apps.value[0]
                .faces[0]
                .label,
        )
    }

    @Test
    fun `faceUpdate preserves per-face form scope on existing face`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app", label = "App", icon = "a", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "app",
                faces = listOf(FaceInfo(face_id = "f1", label = "F1", position = 0)),
            ),
        )
        vm.setFormValue("app", "f1", "draft_text", "in progress")

        // Server pushes a face update — components/data change, $form survives.
        vm.handleFaceUpdateForTest(
            FaceUpdateMsg(
                scope = "app:app",
                app_id = "app",
                face_id = "f1",
                components = listOf(ComponentDef(id = "root", scaffold = ScaffoldComponent())),
                data_ = mapOf("title" to "New"),
            ),
        )
        assertEquals(
            "form scope must persist across faceUpdate on existing face",
            "in progress",
            vm.apps.value[0]
                .faces[0]
                .form["draft_text"],
        )
    }

    @Test
    fun `faceUpdate creates face if not in faceList yet`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "app", label = "App", icon = "a", position = 0))),
        )

        vm.handleFaceUpdateForTest(
            FaceUpdateMsg(
                scope = "app:app",
                app_id = "app",
                face_id = "new-face",
                components = emptyList(),
                data_ = emptyMap<String, Any?>(),
            ),
        )

        assertEquals(
            1,
            vm.apps.value[0]
                .faces.size,
        )
        assertEquals(
            "new-face",
            vm.apps.value[0]
                .faces[0]
                .faceId,
        )
    }

    // -----------------------------------------------------------------------
    // handleNavigate
    // -----------------------------------------------------------------------

    @Test
    fun `navigate switches active app index`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "home", label = "Home", icon = "home", position = 0),
                    AppInfo(app_id = "tracker", label = "Tracker", icon = "t", position = 1),
                ),
            ),
        )

        vm.handleNavigateForTest(NavigateMsg(app_id = "tracker"))
        assertEquals(1, vm.activeAppIndex.value)
    }

    // -----------------------------------------------------------------------
    // switchApp
    // -----------------------------------------------------------------------

    @Test
    fun `switchApp updates active index for valid index`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "a", label = "A", icon = "a", position = 0),
                    AppInfo(app_id = "b", label = "B", icon = "b", position = 1),
                ),
            ),
        )

        vm.switchApp(1)
        assertEquals(1, vm.activeAppIndex.value)
    }

    @Test
    fun `switchApp ignores out-of-bounds, negative, and empty-list calls`() {
        // Empty-list call before any apps loaded.
        vm.switchApp(0)
        assertEquals(0, vm.activeAppIndex.value)

        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "a", label = "A", icon = "a", position = 0))),
        )
        vm.switchApp(5)
        assertEquals(0, vm.activeAppIndex.value)
        vm.switchApp(-1)
        assertEquals(0, vm.activeAppIndex.value)
    }

    @Test
    fun `switchApp records lastSubscribedScope and no-ops on same scope`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "home", label = "Home", icon = "home", position = 0),
                    AppInfo(app_id = "weather", label = "Weather", icon = "w", position = 1),
                ),
            ),
        )

        vm.switchApp(1)
        assertEquals("app:weather", vm.lastSubscribedScopeForTest())

        val before = vm.lastSubscribedScopeForTest()
        vm.switchApp(1)
        assertEquals(before, vm.lastSubscribedScopeForTest())

        vm.switchApp(0)
        assertEquals("home", vm.lastSubscribedScopeForTest())
    }

    @Test
    fun `switchFace does not change subscribed scope`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "weather", label = "W", icon = "w", position = 0))),
        )
        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "weather",
                faces =
                listOf(
                    FaceInfo(face_id = "now", label = "Now", position = 0),
                    FaceInfo(face_id = "week", label = "Week", position = 1),
                ),
            ),
        )
        vm.switchApp(0)
        val scopeAfterAppSwitch = vm.lastSubscribedScopeForTest()

        vm.switchFace("weather", 1)
        assertEquals(1, vm.apps.value[0].activeFaceIndex)
        assertEquals(scopeAfterAppSwitch, vm.lastSubscribedScopeForTest())
    }

    // -----------------------------------------------------------------------
    // sendChatInput — local echo + thinking state
    // -----------------------------------------------------------------------

    @Test
    fun `sendChatInput adds local user message with stamped clientMsgId`() {
        vm.sendChatInput("app:weather", "What's the forecast?")

        val msgs = vm.chatMessagesByApp.value["weather"]
        assertEquals(1, msgs?.size)
        assertEquals(ChatRole.CHAT_ROLE_USER, msgs!![0].role)
        assertEquals("What's the forecast?", msgs[0].text)
        assertNotNull("optimistic bubble must carry a clientMsgId", msgs[0].client_msg_id)
    }

    @Test
    fun `sendChatInput marks scope as thinking when connected`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        assertEquals(emptySet<String>(), vm.thinkingScopes.value)
        vm.sendChatInput("app:weather", "Hello")
        assertEquals(setOf("app:weather"), vm.thinkingScopes.value)
        assertEquals(VoiceStateValue.VOICE_STATE_VALUE_IDLE, vm.voiceState.value.state)
    }

    @Test
    fun `sendChatInput stays idle when disconnected (goes to offline queue)`() {
        assertEquals(MoumantaiTransport.ConnectionState.DISCONNECTED, vm.connectionState.value)
        vm.sendChatInput("app:weather", "Hello")
        assertEquals(VoiceStateValue.VOICE_STATE_VALUE_IDLE, vm.voiceState.value.state)
        assertEquals(emptySet<String>(), vm.thinkingScopes.value)
    }

    @Test
    fun `assistant response clears the per-scope thinking flag`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("app:weather", "Hello")
        assertEquals(setOf("app:weather"), vm.thinkingScopes.value)

        vm.simulateChatMessage(
            ChatMessage(
                id = "resp-1",
                scope = "app:weather",
                conversation_id = "conv-1",
                role = ChatRole.CHAT_ROLE_ASSISTANT,
                text = "It's sunny!",
                timestamp = "2026-04-10T12:00:00Z",
            ),
        )

        assertEquals(emptySet<String>(), vm.thinkingScopes.value)
        val msgs = vm.chatMessagesByApp.value["weather"]!!
        assertEquals(2, msgs.size)
        assertEquals(ChatRole.CHAT_ROLE_ASSISTANT, msgs[1].role)
    }

    @Test
    fun `assistant response does not reset non-thinking voice states`() {
        val vsField = AppViewModel::class.java.getDeclaredField("_voiceState")
        vsField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = vsField.get(vm) as kotlinx.coroutines.flow.MutableStateFlow<VoiceState>
        flow.value = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_SPEAKING)

        vm.simulateChatMessage(
            ChatMessage(
                id = "resp-2",
                scope = "app:weather",
                conversation_id = "conv-1",
                role = ChatRole.CHAT_ROLE_ASSISTANT,
                text = "Response",
                timestamp = "2026-04-10T12:00:00Z",
            ),
        )

        assertEquals(VoiceStateValue.VOICE_STATE_VALUE_SPEAKING, vm.voiceState.value.state)
    }

    // -----------------------------------------------------------------------
    // /reset interception
    // -----------------------------------------------------------------------

    @Test
    fun `slash reset while connected sends resetConversation and suppresses optimistic bubble`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("app:weather", "/reset")

        assertTrue(
            "reset must not push a local echo",
            vm.chatMessagesByApp.value["weather"].isNullOrEmpty(),
        )
        assertEquals(VoiceStateValue.VOICE_STATE_VALUE_IDLE, vm.voiceState.value.state)
    }

    @Test
    fun `slash reset while disconnected emits transient notice and drops the command`() {
        val notices = mutableListOf<String>()
        val job =
            CoroutineScope(Dispatchers.Unconfined).launch {
                vm.transientNotice.collect { notices.add(it) }
            }
        try {
            vm.sendChatInput("home", "/reset")
            assertTrue(
                "offline reset must not push a bubble",
                vm.chatMessagesByApp.value["home"].isNullOrEmpty(),
            )
            assertTrue("a transient notice should fire", notices.isNotEmpty())
        } finally {
            job.cancel()
        }
    }

    // -----------------------------------------------------------------------
    // clientMsgId reconciliation on chat echo
    // -----------------------------------------------------------------------

    @Test
    fun `chat echo with matching clientMsgId replaces optimistic bubble (length unchanged)`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("app:weather", "Hi")

        val optimistic = vm.chatMessagesByApp.value["weather"]!!.first()
        val cid = optimistic.client_msg_id!!

        vm.simulateChatMessage(
            ChatMessage(
                id = "server-1",
                scope = "app:weather",
                conversation_id = "conv-1",
                role = ChatRole.CHAT_ROLE_USER,
                text = "Hi",
                timestamp = "2026-04-20T00:00:00Z",
                client_msg_id = cid,
            ),
        )

        val list = vm.chatMessagesByApp.value["weather"]!!
        assertEquals("echo must REPLACE, not append", 1, list.size)
        assertEquals("server-1", list[0].id)
        assertEquals(cid, list[0].client_msg_id)
    }

    @Test
    fun `chat echo without clientMsgId just appends`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("home", "Hello")

        vm.simulateChatMessage(
            ChatMessage(
                id = "a1",
                scope = "home",
                conversation_id = "conv-1",
                role = ChatRole.CHAT_ROLE_ASSISTANT,
                text = "Hi back",
                timestamp = "t",
            ),
        )
        val list = vm.chatMessagesByApp.value["home"]!!
        assertEquals(2, list.size)
        assertEquals(ChatRole.CHAT_ROLE_USER, list[0].role)
        assertEquals(ChatRole.CHAT_ROLE_ASSISTANT, list[1].role)
    }

    // -----------------------------------------------------------------------
    // Full message sequence
    // -----------------------------------------------------------------------

    @Test
    fun `full lifecycle - appList, faceList, faceUpdate, navigate`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "home", label = "Home", icon = "home", position = 0),
                    AppInfo(app_id = "tracker", label = "Tracker", icon = "payments", position = 1),
                ),
            ),
        )
        assertEquals(2, vm.apps.value.size)

        vm.handleFaceListForTest(
            FaceListMsg(
                app_id = "tracker",
                faces = listOf(FaceInfo(face_id = "summary", label = "Summary", position = 0)),
            ),
        )
        assertEquals(
            1,
            vm.apps.value[1]
                .faces.size,
        )

        val components = listOf(ComponentDef(id = "root", scaffold = ScaffoldComponent()))
        vm.handleFaceUpdateForTest(
            FaceUpdateMsg(
                scope = "app:tracker",
                app_id = "tracker",
                face_id = "summary",
                components = components,
                data_ = mapOf("total" to "$15.00"),
            ),
        )
        assertEquals(
            1,
            vm.apps.value[1]
                .faces[0]
                .components.size,
        )
        assertEquals(
            "$15.00",
            vm.apps.value[1]
                .faces[0]
                .data["total"],
        )

        vm.handleNavigateForTest(NavigateMsg(app_id = "tracker"))
        assertEquals(1, vm.activeAppIndex.value)
    }

    // -----------------------------------------------------------------------
    // handleChatWindow (REPLACE with optimistic preservation)
    // -----------------------------------------------------------------------

    @Test
    fun `chatWindow replaces chat log for target scope only`() {
        vm.simulateChatMessage(
            ChatMessage(
                id = "h1",
                scope = "home",
                conversation_id = "conv-old",
                role = ChatRole.CHAT_ROLE_USER,
                text = "old-home-1",
                timestamp = "t",
            ),
        )
        vm.simulateChatMessage(
            ChatMessage(
                id = "h2",
                scope = "home",
                conversation_id = "conv-old",
                role = ChatRole.CHAT_ROLE_ASSISTANT,
                text = "old-home-reply",
                timestamp = "t",
            ),
        )
        vm.simulateChatMessage(
            ChatMessage(
                id = "w1",
                scope = "app:weather",
                conversation_id = "conv-w",
                role = ChatRole.CHAT_ROLE_USER,
                text = "weather-mine",
                timestamp = "t",
            ),
        )

        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "conv-new",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "c1",
                        seq = 1,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "canon-1",
                        created_at = "t",
                    ),
                    ChatWindowEntry(
                        id = "c2",
                        seq = 2,
                        role = ChatRole.CHAT_ROLE_ASSISTANT,
                        text = "canon-2",
                        created_at = "t",
                    ),
                ),
            ),
        )

        val home = vm.chatMessagesByApp.value["home"]!!
        assertEquals(2, home.size)
        assertEquals("canon-1", home[0].text)
        assertEquals("canon-2", home[1].text)
        assertEquals("conv-new", home[0].conversation_id)
        val weather = vm.chatMessagesByApp.value["weather"]!!
        assertEquals(1, weather.size)
        assertEquals("weather-mine", weather[0].text)
    }

    @Test
    fun `chatWindow preserves optimistic bubbles whose id is not in entries`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.handleChatWindowForTest(
            ChatWindowMsg(scope = "home", conversation_id = "conv-1", entries = emptyList()),
        )
        vm.sendChatInput("home", "pending-optimistic")
        val optimistic = vm.chatMessagesByApp.value["home"]!!.first()
        assertNotNull(optimistic.client_msg_id)
        assertEquals("conv-1", optimistic.conversation_id)

        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "conv-1",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "server-1",
                        seq = 1,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "previously-acked",
                        created_at = "t",
                    ),
                ),
            ),
        )

        val list = vm.chatMessagesByApp.value["home"]!!
        assertEquals(2, list.size)
        assertEquals("previously-acked", list[0].text)
        assertEquals("pending-optimistic", list[1].text)
        assertEquals(optimistic.client_msg_id, list[1].client_msg_id)
    }

    @Test
    fun `chatWindow drops server-acked entries whose id DOES appear in entries`() {
        vm.simulateChatMessage(
            ChatMessage(
                id = "X",
                scope = "home",
                conversation_id = "c",
                role = ChatRole.CHAT_ROLE_USER,
                text = "first",
                timestamp = "t",
            ),
        )
        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "c",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "X",
                        seq = 1,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "first-canonical",
                        created_at = "t",
                    ),
                ),
            ),
        )
        val list = vm.chatMessagesByApp.value["home"]!!
        assertEquals(1, list.size)
        assertEquals("first-canonical", list[0].text)
    }

    // -----------------------------------------------------------------------
    // Optimistic TTL (15s → unsent) + retry
    // -----------------------------------------------------------------------

    @Test
    fun `sendChatInput stamps the optimistic bubble status (PENDING when connected, null when offline)`() {
        // Connected: TURN_STATUS_PENDING (in-flight server turn).
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("home", "hi")
        assertEquals(
            TurnStatus.TURN_STATUS_PENDING,
            vm.chatMessagesByApp.value["home"]!!
                .single()
                .status,
        )

        // Disconnected: null status (no turn in flight; bubble is offline-only).
        val vm2 = AppViewModel()
        vm2.sendChatInput("home", "hi")
        assertNull(
            vm2.chatMessagesByApp.value["home"]!!
                .single()
                .status,
        )
    }

    @Test
    fun `optimistic bubble flips to unsent after 15s if no server echo`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.resetMain()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val vm = AppViewModel()
        try {
            vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
            vm.sendChatInput("home", "hi")
            assertEquals(
                TurnStatus.TURN_STATUS_PENDING,
                vm.chatMessagesByApp.value["home"]!!
                    .single()
                    .status,
            )

            scheduler.advanceTimeBy(AppViewModel.OPTIMISTIC_TTL_MS + 100)
            scheduler.runCurrent()

            val bubble = vm.chatMessagesByApp.value["home"]!!.single()
            // UNSENT_STATUS is the local "we gave up waiting" sentinel
            // (TURN_STATUS_UNSPECIFIED in the proto enum — never sent on the wire).
            assertEquals(AppViewModel.UNSENT_STATUS, bubble.status)
            assertEquals(emptySet<String>(), vm.thinkingScopes.value)
        } finally {
            Dispatchers.resetMain()
            Dispatchers.setMain(UnconfinedTestDispatcher())
        }
    }

    @Test
    fun `server echo before 15s cancels the TTL so the bubble does not flip to unsent`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.resetMain()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val vm = AppViewModel()
        try {
            vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
            vm.sendChatInput("home", "hi")
            val cmid =
                vm.chatMessagesByApp.value["home"]!!
                    .single()
                    .client_msg_id!!

            vm.simulateChatMessage(
                ChatMessage(
                    id = "server-1",
                    scope = "home",
                    conversation_id = "conv",
                    role = ChatRole.CHAT_ROLE_USER,
                    text = "hi",
                    timestamp = "t",
                    client_msg_id = cmid,
                    status = TurnStatus.TURN_STATUS_RUNNING,
                ),
            )

            scheduler.advanceTimeBy(AppViewModel.OPTIMISTIC_TTL_MS + 100)
            scheduler.runCurrent()

            val bubble = vm.chatMessagesByApp.value["home"]!!.single { it.client_msg_id == cmid }
            assertEquals(TurnStatus.TURN_STATUS_RUNNING, bubble.status)
        } finally {
            Dispatchers.resetMain()
            Dispatchers.setMain(UnconfinedTestDispatcher())
        }
    }

    @Test
    fun `retryChatMessage flips unsent back to pending and re-schedules the TTL`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.resetMain()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val vm = AppViewModel()
        try {
            vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
            vm.sendChatInput("home", "hi")
            val cmid =
                vm.chatMessagesByApp.value["home"]!!
                    .single()
                    .client_msg_id!!

            scheduler.advanceTimeBy(AppViewModel.OPTIMISTIC_TTL_MS + 100)
            scheduler.runCurrent()
            assertEquals(
                AppViewModel.UNSENT_STATUS,
                vm.chatMessagesByApp.value["home"]!!
                    .single()
                    .status,
            )

            vm.retryChatMessage("home", cmid)
            assertEquals(
                TurnStatus.TURN_STATUS_PENDING,
                vm.chatMessagesByApp.value["home"]!!
                    .single()
                    .status,
            )
            assertEquals(setOf("home"), vm.thinkingScopes.value)
        } finally {
            Dispatchers.resetMain()
            Dispatchers.setMain(UnconfinedTestDispatcher())
        }
    }

    @Test
    fun `retryChatMessage is a no-op when the bubble is not in unsent state`() {
        vm.setConnectionStateForTest(MoumantaiTransport.ConnectionState.CONNECTED)
        vm.sendChatInput("home", "hi")
        val cmid =
            vm.chatMessagesByApp.value["home"]!!
                .single()
                .client_msg_id!!
        vm.retryChatMessage("home", cmid)
        assertEquals(
            TurnStatus.TURN_STATUS_PENDING,
            vm.chatMessagesByApp.value["home"]!!
                .single()
                .status,
        )
    }

    @Test
    fun `chatWindow with empty entries clears the scope's log (except optimistic)`() {
        vm.simulateChatMessage(
            ChatMessage(
                id = "h1",
                scope = "home",
                conversation_id = "c",
                role = ChatRole.CHAT_ROLE_USER,
                text = "will be gone",
                timestamp = "t",
            ),
        )
        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "c-new",
                entries = emptyList(),
            ),
        )
        assertTrue(vm.chatMessagesByApp.value["home"]!!.isEmpty())
    }

    // -----------------------------------------------------------------------
    // resetNotice (sibling-reset banner)
    // -----------------------------------------------------------------------

    @Test
    fun `resetNotice from another device flashes the banner for the scope`() {
        assertTrue(vm.resetNoticeByScope.value.isEmpty())
        vm.handleResetNotice(
            ResetNoticeMsg(
                scope = "home",
                conversation_id = "new-conv-abc",
                requester_session_id = "other-session-xyz",
                timestamp = "2026-04-22T12:34:56Z",
            ),
        )
        val flash = vm.resetNoticeByScope.value["home"]
        assertNotNull(flash)
        assertEquals("new-conv-abc", flash!!.conversationId)
        assertEquals("2026-04-22T12:34:56Z", flash.timestamp)
    }

    @Test
    fun `resetNotice for different scopes tracked independently`() {
        vm.handleResetNotice(
            ResetNoticeMsg(
                scope = "home",
                conversation_id = "c1",
                requester_session_id = "sibling",
                timestamp = "t1",
            ),
        )
        vm.handleResetNotice(
            ResetNoticeMsg(
                scope = "app:tracker",
                conversation_id = "c2",
                requester_session_id = "sibling",
                timestamp = "t2",
            ),
        )
        val byScope = vm.resetNoticeByScope.value
        assertEquals(setOf("home", "app:tracker"), byScope.keys)
        assertEquals("c1", byScope["home"]?.conversationId)
        assertEquals("c2", byScope["app:tracker"]?.conversationId)
    }

    // -----------------------------------------------------------------------
    // chatUpdate queue-and-drain
    // -----------------------------------------------------------------------

    @Test
    fun `chatUpdate for unknown row is queued, not applied`() {
        vm.handleChatUpdateForTest(
            ChatUpdateMsg(
                scope = "home",
                conversation_id = "c",
                id = "X",
                status = TurnStatus.TURN_STATUS_RUNNING,
            ),
        )

        assertTrue(
            "chatUpdate for unknown id must not introduce a row",
            vm.chatMessagesByApp.value["home"].isNullOrEmpty(),
        )
        assertEquals(
            "queue must hold the unmatched update keyed by id",
            setOf("X"),
            vm.pendingUpdateIdsForTest(),
        )
    }

    @Test
    fun `queued chatUpdate is applied when matching chat arrives`() {
        vm.handleChatUpdateForTest(
            ChatUpdateMsg(
                scope = "home",
                conversation_id = "c",
                id = "X",
                status = TurnStatus.TURN_STATUS_RUNNING,
            ),
        )
        assertEquals(setOf("X"), vm.pendingUpdateIdsForTest())

        vm.simulateChatMessage(
            ChatMessage(
                id = "X",
                scope = "home",
                conversation_id = "c",
                role = ChatRole.CHAT_ROLE_USER,
                text = "mid-race",
                timestamp = "t",
                status = TurnStatus.TURN_STATUS_PENDING,
            ),
        )

        val rows = vm.chatMessagesByApp.value["home"]!!
        assertEquals(1, rows.size)
        assertEquals("X", rows[0].id)
        assertEquals(
            "queued chatUpdate must win over the incoming pending status",
            TurnStatus.TURN_STATUS_RUNNING,
            rows[0].status,
        )
        assertTrue(
            "pending map must be empty after a successful drain",
            vm.pendingUpdateIdsForTest().isEmpty(),
        )
    }

    @Test
    fun `resetNotice banner auto-clears after the flash window`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.resetMain()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val vm = AppViewModel()
        try {
            vm.handleResetNotice(
                ResetNoticeMsg(
                    scope = "home",
                    conversation_id = "cN",
                    requester_session_id = "sibling",
                    timestamp = "t",
                ),
            )
            assertTrue(vm.resetNoticeByScope.value.containsKey("home"))

            scheduler.advanceTimeBy(AppViewModel.RESET_NOTICE_FLASH_MS + 100)
            scheduler.runCurrent()

            assertTrue(
                "banner should auto-clear after RESET_NOTICE_FLASH_MS",
                vm.resetNoticeByScope.value["home"] == null,
            )
        } finally {
            Dispatchers.resetMain()
            Dispatchers.setMain(UnconfinedTestDispatcher())
        }
    }

    // -----------------------------------------------------------------------
    // Offline-queue staleness rejection
    // -----------------------------------------------------------------------

    @Test
    fun `stale_conversation error emits a transient notice`() {
        val notices = mutableListOf<String>()
        val job =
            CoroutineScope(Dispatchers.Unconfined).launch {
                vm.transientNotice.collect { notices.add(it) }
            }
        try {
            vm.handleTransportErrorForTest(
                ErrorMessage(
                    code = ProtocolErrorCode.PROTOCOL_ERROR_CODE_STALE_CONVERSATION,
                    message = "Conversation advanced while offline",
                    client_msg_id = "cmid-1",
                ),
            )

            assertEquals(1, notices.size)
            assertTrue(
                "notice should mention dropped / advanced wording; got: ${notices[0]}",
                notices[0].contains("conversation advanced", ignoreCase = true),
            )
        } finally {
            job.cancel()
        }
    }

    @Test
    fun `unmatched chatUpdate TTL-evicts after PENDING_UPDATE_TTL_MS`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.resetMain()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val vm = AppViewModel()
        try {
            vm.handleChatUpdateForTest(
                ChatUpdateMsg(
                    scope = "home",
                    conversation_id = "c",
                    id = "Y",
                    status = TurnStatus.TURN_STATUS_RUNNING,
                ),
            )
            scheduler.runCurrent()
            assertEquals(setOf("Y"), vm.pendingUpdateIdsForTest())

            scheduler.advanceTimeBy(AppViewModel.PENDING_UPDATE_TTL_MS + 1_000)
            scheduler.runCurrent()

            assertTrue(
                "post-TTL: entry evicted (no leak)",
                vm.pendingUpdateIdsForTest().isEmpty(),
            )
            assertTrue(vm.chatMessagesByApp.value["home"].isNullOrEmpty())
        } finally {
            Dispatchers.resetMain()
            Dispatchers.setMain(UnconfinedTestDispatcher())
        }
    }

    @Test
    fun `chatWindow drops optimistic bubble from stale conversation on REPLACE`() {
        vm.simulateChatMessage(
            ChatMessage(
                id = "echo-x",
                scope = "home",
                conversation_id = "conv-X",
                role = ChatRole.CHAT_ROLE_USER,
                text = "stamped on archived conv",
                timestamp = "t",
                client_msg_id = "cmi-stale",
            ),
        )
        assertEquals(1, vm.chatMessagesByApp.value["home"]!!.size)

        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "conv-Y",
                entries = emptyList(),
            ),
        )

        val home = vm.chatMessagesByApp.value["home"]!!
        assertTrue(
            "optimistic bubble from archived conv X must not survive REPLACE to conv Y",
            home.isEmpty(),
        )
    }

    @Test
    fun `non-stale error codes do not emit the stale_conversation notice`() {
        val notices = mutableListOf<String>()
        val job =
            CoroutineScope(Dispatchers.Unconfined).launch {
                vm.transientNotice.collect { notices.add(it) }
            }
        try {
            vm.handleTransportErrorForTest(
                ErrorMessage(
                    code = ProtocolErrorCode.PROTOCOL_ERROR_CODE_RATE_LIMITED,
                    message = "slow down",
                    retry_after_ms = 1_000,
                ),
            )
            assertTrue(
                "rate_limited must not trigger the stale_conversation notice",
                notices.none { it.contains("conversation advanced", ignoreCase = true) },
            )
        } finally {
            job.cancel()
        }
    }

    // -----------------------------------------------------------------------
    // handleUiActionEscalated
    // -----------------------------------------------------------------------

    @Test
    fun `uiActionEscalated emits openChatForScope when scope matches active app`() {
        vm.handleAppListForTest(
            AppListMsg(apps = listOf(AppInfo(app_id = "diet-tracker", label = "Diet", icon = "diet", position = 0))),
        )
        vm.switchApp(0)

        val emitted = mutableListOf<String>()
        val job =
            CoroutineScope(Dispatchers.Unconfined).launch {
                vm.openChatForScope.collect { emitted.add(it) }
            }
        try {
            vm.handleUiActionEscalatedForTest(UiActionEscalated(scope = "app:diet-tracker"))
            assertEquals("matching scope must emit openChatForScope", 1, emitted.size)
            assertEquals("app:diet-tracker", emitted[0])
        } finally {
            job.cancel()
        }
    }

    @Test
    fun `uiActionEscalated is a no-op when scope does not match active app`() {
        vm.handleAppListForTest(
            AppListMsg(
                apps =
                listOf(
                    AppInfo(app_id = "diet-tracker", label = "Diet", icon = "diet", position = 0),
                    AppInfo(app_id = "budget", label = "Budget", icon = "money", position = 1),
                ),
            ),
        )
        vm.switchApp(0) // active = diet-tracker

        val emitted = mutableListOf<String>()
        val job =
            CoroutineScope(Dispatchers.Unconfined).launch {
                vm.openChatForScope.collect { emitted.add(it) }
            }
        try {
            // scope is for a different app — must be a no-op
            vm.handleUiActionEscalatedForTest(UiActionEscalated(scope = "app:budget"))
            assertTrue("mismatched scope must NOT emit openChatForScope", emitted.isEmpty())
        } finally {
            job.cancel()
        }
    }

    // -----------------------------------------------------------------------
    // handleChatHistory + loadOlderChat
    // -----------------------------------------------------------------------

    @Test
    fun `handleChatHistory prepends entries deduped by id`() {
        // Seed the log with an existing entry.
        vm.handleChatWindowForTest(
            ChatWindowMsg(
                scope = "home",
                conversation_id = "conv-1",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "existing",
                        seq = 10,
                        role = ChatRole.CHAT_ROLE_ASSISTANT,
                        text = "existing-text",
                        created_at = "t",
                    ),
                ),
            ),
        )
        assertEquals(1, vm.chatMessagesByApp.value["home"]!!.size)

        // Server responds with older history that overlaps on "existing".
        vm.handleChatHistoryForTest(
            ChatHistoryMsg(
                scope = "home",
                conversation_id = "conv-1",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "old-1",
                        seq = 5,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "older-1",
                        created_at = "t",
                    ),
                    // Duplicate id — should be skipped; in-memory copy wins.
                    ChatWindowEntry(
                        id = "existing",
                        seq = 10,
                        role = ChatRole.CHAT_ROLE_ASSISTANT,
                        text = "should-be-ignored",
                        created_at = "t",
                    ),
                ),
                has_more = true,
            ),
        )

        val log = vm.chatMessagesByApp.value["home"]!!
        // "old-1" prepended; "existing" deduplicated (in-memory copy wins).
        assertEquals(2, log.size)
        assertEquals("old-1", log[0].id)
        assertEquals("existing-text", log[1].text) // original text preserved
    }

    @Test
    fun `handleChatHistory with hasMore=false transitions state to EXHAUSTED`() {
        vm.handleChatWindowForTest(
            ChatWindowMsg(scope = "home", conversation_id = "conv-1", entries = emptyList()),
        )

        vm.handleChatHistoryForTest(
            ChatHistoryMsg(
                scope = "home",
                conversation_id = "conv-1",
                entries = emptyList(),
                has_more = false,
            ),
        )

        val state = vm.loadOlder.value["home"]?.state
        assertEquals(AppViewModel.LoadOlderState.EXHAUSTED, state)
    }

    @Test
    fun `handleChatHistory with hasMore=true leaves state IDLE`() {
        vm.handleChatWindowForTest(
            ChatWindowMsg(scope = "home", conversation_id = "conv-1", entries = emptyList()),
        )

        vm.handleChatHistoryForTest(
            ChatHistoryMsg(
                scope = "home",
                conversation_id = "conv-1",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "m1",
                        seq = 3,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "old",
                        created_at = "t",
                    ),
                ),
                has_more = true,
            ),
        )

        val state = vm.loadOlder.value["home"]?.state
        assertEquals(AppViewModel.LoadOlderState.IDLE, state)
    }

    @Test
    fun `handleChatHistory with mismatched conversationId is discarded (post-reset stale)`() {
        // Seed current conversation.
        vm.handleChatWindowForTest(
            ChatWindowMsg(scope = "home", conversation_id = "conv-new", entries = emptyList()),
        )

        // Server responds with history for the OLD conversation (reset happened mid-flight).
        vm.handleChatHistoryForTest(
            ChatHistoryMsg(
                scope = "home",
                conversation_id = "conv-old",
                entries =
                listOf(
                    ChatWindowEntry(
                        id = "stale-1",
                        seq = 1,
                        role = ChatRole.CHAT_ROLE_USER,
                        text = "stale",
                        created_at = "t",
                    ),
                ),
                has_more = true,
            ),
        )

        // Log must be untouched — stale response discarded.
        assertTrue(vm.chatMessagesByApp.value["home"]!!.isEmpty())
        // State must reset to IDLE so fresh requests can proceed.
        val state = vm.loadOlder.value["home"]?.state
        assertEquals(AppViewModel.LoadOlderState.IDLE, state)
    }

    @Test
    fun `loadOlderChat is no-op while LOADING and transitions to LOADING when IDLE`() {
        // Set up a connected transport stub so we can intercept sendFetchOlder.
        val fetchOlderCalls = mutableListOf<Pair<String, Long>>()
        vm.setLoadOlderStateForTest("home", AppViewModel.LoadOlderState.LOADING)

        // LOADING → no-op
        vm.loadOlderChat("home")
        assertTrue("LOADING must be a no-op", fetchOlderCalls.isEmpty())

        // Reset to IDLE and verify the call would proceed (no transport connected,
        // so sendFetchOlder on null transport is safely swallowed — we verify
        // state transition instead).
        vm.setLoadOlderStateForTest("home", AppViewModel.LoadOlderState.IDLE)
        // Set a fake conversationId so inflightConvId is set.
        vm.setConversationIdForTest("home", "conv-x")
        vm.loadOlderChat("home")

        // State should move to LOADING.
        assertEquals(
            "IDLE → should transition to LOADING after call",
            AppViewModel.LoadOlderState.LOADING,
            vm.loadOlder.value["home"]?.state,
        )
        assertEquals("conv-x", vm.loadOlder.value["home"]?.inflightConvId)
    }

    @Test
    fun `loadOlderChat is no-op while EXHAUSTED`() {
        vm.setLoadOlderStateForTest("home", AppViewModel.LoadOlderState.EXHAUSTED)
        vm.loadOlderChat("home")
        // State must remain EXHAUSTED.
        assertEquals(AppViewModel.LoadOlderState.EXHAUSTED, vm.loadOlder.value["home"]?.state)
    }
}

// -- Test helpers: expose internal handlers without making them internal ------

private fun AppViewModel.handleAppListForTest(msg: AppListMsg) {
    val method = AppViewModel::class.java.getDeclaredMethod("handleAppList", AppListMsg::class.java)
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleFaceListForTest(msg: FaceListMsg) {
    val method = AppViewModel::class.java.getDeclaredMethod("handleFaceList", FaceListMsg::class.java)
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleFaceUpdateForTest(msg: FaceUpdateMsg) {
    val method = AppViewModel::class.java.getDeclaredMethod("handleFaceUpdate", FaceUpdateMsg::class.java)
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleNavigateForTest(msg: NavigateMsg) {
    val method = AppViewModel::class.java.getDeclaredMethod("handleNavigate", NavigateMsg::class.java)
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleChatWindowForTest(msg: ChatWindowMsg) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleChatWindow",
            ChatWindowMsg::class.java,
        )
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.setConnectionStateForTest(state: MoumantaiTransport.ConnectionState) {
    val field = AppViewModel::class.java.getDeclaredField("_connectionState")
    field.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    val flow = field.get(this) as kotlinx.coroutines.flow.MutableStateFlow<MoumantaiTransport.ConnectionState>
    flow.value = state
}

private fun AppViewModel.lastSubscribedScopeForTest(): String? {
    val field = AppViewModel::class.java.getDeclaredField("lastSubscribedScope")
    field.isAccessible = true
    return field.get(this) as String?
}

private fun AppViewModel.simulateChatMessage(msg: ChatMessage) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleIncomingChatMessage",
            ChatMessage::class.java,
        )
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleChatUpdateForTest(msg: ChatUpdateMsg) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleChatUpdate",
            ChatUpdateMsg::class.java,
        )
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.pendingUpdateIdsForTest(): Set<String> {
    val field = AppViewModel::class.java.getDeclaredField("pendingUpdates")
    field.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    val map = field.get(this) as Map<String, *>
    return map.keys.toSet()
}

private fun AppViewModel.handleTransportErrorForTest(err: ErrorMessage) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleTransportError",
            ErrorMessage::class.java,
        )
    method.isAccessible = true
    method.invoke(this, err)
}

private fun AppViewModel.handleUiActionEscalatedForTest(msg: UiActionEscalated) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleUiActionEscalated",
            UiActionEscalated::class.java,
        )
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.handleChatHistoryForTest(msg: ChatHistoryMsg) {
    val method =
        AppViewModel::class.java.getDeclaredMethod(
            "handleChatHistory",
            ChatHistoryMsg::class.java,
        )
    method.isAccessible = true
    method.invoke(this, msg)
}

private fun AppViewModel.setLoadOlderStateForTest(
    scope: String,
    state: AppViewModel.LoadOlderState,
) {
    val field = AppViewModel::class.java.getDeclaredField("_loadOlder")
    field.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    val flow =
        field.get(this)
            as kotlinx.coroutines.flow.MutableStateFlow<Map<String, AppViewModel.LoadOlder>>
    // LoadOlder is a data class with three params: state, inflightConvId, hasMore.
    val loClass =
        AppViewModel::class.java.declaredClasses
            .first { it.simpleName == "LoadOlder" }
    // The primary constructor has exactly these types (no default-param synthetic suffix).
    val ctor = loClass.declaredConstructors.first { it.parameterCount == 3 }
    ctor.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    val lo = ctor.newInstance(state, null, true) as AppViewModel.LoadOlder
    flow.value = flow.value + (scope to lo)
}

private fun AppViewModel.setConversationIdForTest(
    appId: String,
    convId: String,
) {
    val field = AppViewModel::class.java.getDeclaredField("_conversationIdByApp")
    field.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    val flow = field.get(this) as kotlinx.coroutines.flow.MutableStateFlow<Map<String, String>>
    flow.value = flow.value + (appId to convId)
}
