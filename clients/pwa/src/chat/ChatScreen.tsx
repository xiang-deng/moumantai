import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChatStore, type ChatMessageDisplay } from '../stores/chat-store'
import { useConnectionStore } from '../stores/connection-store'
import { useAppStore } from '../renderer/stores/app-store'
import type { WebSocketTransport } from '../transport/ws-transport'
import { ChatBubble } from './ChatBubble'
import { VoiceIndicator } from './VoiceIndicator'
import { ImagePicker } from './ImagePicker'
import { useVoiceCapture } from '../hooks/useVoiceCapture'
import { useVadTimer } from '../hooks/useVadTimer'
import { haptic } from '../hooks/useHaptic'
import { appIdToScope } from '@moumantai/protocol'
import { VoiceStateValue, DraftKind, TodoStatus } from '@moumantai/protocol/generated/moumantai/v1'
import styles from './ChatScreen.module.css'

export interface ChatScreenProps {
  appId: string
  transport: WebSocketTransport | null
  /** Server dev-mode capability (ServerHello.dev_mode_enabled). The Dev pill
   *  shows only when this is true AND the client opted in via localStorage. */
  devModeEnabled?: boolean
  /** Whether this chat is the currently-viewed app. The home chat lives in an
   *  always-mounted pager slot, so it must re-snap to the bottom when swiped
   *  back to (it never remounts). Sheet-mounted app chats mount on open, so
   *  this defaults to true. */
  active?: boolean
}

const EMPTY: ChatMessageDisplay[] = []

/**
 * Full chat surface. Used:
 *   - As the home app's primary content (always-on full-screen)
 *   - Inside `Sheet` when a mini-app opens its bottom chat bar
 *
 * Voice: PCM16 capture via AudioWorklet (16 kHz mono, 256 ms chunks), VAD
 * with 1.5 s silence + 30 s hard cap, mirroring Android `AudioConfig.kt`.
 *
 * Dev mode (gated): a [Chat | Dev] pill flips to a separate dev thread that
 * drives the coding-agent draft pipeline (edit/scaffold → preview → promote).
 */
export function ChatScreen({ appId, transport, devModeEnabled, active = true }: ChatScreenProps) {
  const scope = appIdToScope(appId)
  const messages = useChatStore((s) => s.messagesByApp.get(appId) ?? EMPTY)
  const inputText = useChatStore((s) => s.inputTextByApp.get(appId) ?? '')
  const setInputText = useChatStore((s) => s.setInputText)
  const addMessage = useChatStore((s) => s.addMessage)
  const pending = useChatStore((s) => s.pendingByApp.get(appId) ?? false)
  const setPending = useChatStore((s) => s.setPending)
  const loadOlder = useChatStore((s) => s.loadOlder)
  const loadOlderState = useChatStore((s) => s.loadOlderByScope.get(scope)?.state ?? 'idle')
  const voiceState = useChatStore((s) => s.voiceState)
  const connectionStatus = useConnectionStore((s) => s.status)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Dev-mode tab state — declared above the scroll effects because the
  // snap's chat-visibility condition depends on `activeTab`. The client
  // opt-in is reactive (see the listener effect below), so the pill toggles
  // without remounting this screen.
  const [devOptIn, setDevOptIn] = useState(
    () =>
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('moumantai.devModeOptIn') === 'true',
  )
  const devAvailable = !!devModeEnabled && devOptIn
  const [tab, setTab] = useState<'chat' | 'dev'>('chat')
  const activeTab = devAvailable ? tab : 'chat'
  // The main chat content is only mounted while its tab is selected (the Dev
  // tab swaps in DevSurface). ChatScreen itself does NOT remount on tab switch,
  // so the snap must key off tab visibility too — not just `active` — or
  // returning to the Chat tab leaves the remounted content scrolled to the top.
  const chatShown = active && activeTab === 'chat'

  // VAD wiring. useVoiceCapture needs a stable RMS callback at construction;
  // useVadTimer needs `isCapturing` + `stopCapture` from useVoiceCapture.
  // Break the cycle via a ref-backed forwarder.
  const vadForwarderRef = useRef<((rms: number) => void) | null>(null)
  const stableRmsForwarder = useCallback((rms: number) => {
    vadForwarderRef.current?.(rms)
  }, [])

  const {
    isCapturing,
    prepareAudio,
    startCapture,
    stopCapture,
    error: voiceError,
  } = useVoiceCapture(transport, scope, stableRmsForwarder)

  const notifyRms = useVadTimer({ isCapturing, onTimeout: stopCapture })
  vadForwarderRef.current = notifyRms

  // Snap to bottom synchronously (before paint, no flash) whenever the chat
  // becomes visible — first mount, swiping back to the always-mounted home
  // slot, or switching back from the Dev tab (content remounts, ChatScreen
  // does not). Without re-snapping on `chatShown` it shows the stale top
  // scroll position.
  const didInitialScrollRef = useRef(false)
  useLayoutEffect(() => {
    if (!chatShown) {
      didInitialScrollRef.current = false
      return
    }
    if (didInitialScrollRef.current) return
    // First content render while shown: jump to bottom instantly. Defer marking
    // "done" until messages exist so an empty first render doesn't consume it.
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
    if (messages.length > 0) didInitialScrollRef.current = true
  }, [chatShown, messages.length])

  // A genuinely new message while actively viewing: smooth-scroll to the
  // latest. After the initial instant snap this is a no-op until the next
  // arrival (the end is already in view), so the two effects don't fight.
  useEffect(() => {
    if (!chatShown || !didInitialScrollRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, chatShown])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    let wasAtTop = el.scrollTop === 0
    const onScroll = () => {
      const isAtTop = el.scrollTop === 0
      if (isAtTop && !wasAtTop && loadOlderState === 'idle' && transport) {
        loadOlder(scope, transport)
      }
      wasAtTop = isAtTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scope, transport, loadOlderState, loadOlder])

  const sendWithOptionalImage = useCallback(
    (text: string, image?: { data: Uint8Array; mimeType: string }) => {
      if (!transport) return
      if (text.toLowerCase() === '/reset' && !image) {
        transport.sendResetConversation(scope)
        setInputText(appId, '')
        return
      }
      const clientMsgId = `local-${crypto.randomUUID()}`
      addMessage(appId, {
        id: clientMsgId,
        role: 'user',
        text: image && !text ? '[image]' : text,
        timestamp: new Date().toISOString(),
        status: 'sending',
      })
      setInputText(appId, '')
      setPending(appId, true)
      transport.sendChatInput(scope, text, clientMsgId, image?.data, image?.mimeType)
      haptic('light')
    },
    [appId, scope, transport, addMessage, setInputText, setPending],
  )

  const handleSend = useCallback(() => {
    const text = inputText.trim()
    if (!text || !transport) return
    sendWithOptionalImage(text)
  }, [inputText, transport, sendWithOptionalImage])

  const handleImage = useCallback(
    (data: Uint8Array, mimeType: string) => {
      sendWithOptionalImage(inputText.trim(), { data, mimeType })
    },
    [inputText, sendWithOptionalImage],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // Mic button — iOS requires AudioContext to be primed synchronously inside
  // the gesture handler, BEFORE the first await. prepareAudio() does that;
  // startCapture() then runs the async getUserMedia / worklet load.
  const onMicTap = useCallback(() => {
    haptic('light')
    if (isCapturing) {
      stopCapture()
      return
    }
    prepareAudio() // sync — must run before the await chain
    void startCapture()
  }, [isCapturing, prepareAudio, startCapture, stopCapture])

  // Keep `devOptIn` reactive. SettingsFace dispatches 'moumantai:devmodeoptin'
  // on toggle (same tab); 'storage' covers other tabs.
  useEffect(() => {
    const read = () => setDevOptIn(localStorage.getItem('moumantai.devModeOptIn') === 'true')
    window.addEventListener('moumantai:devmodeoptin', read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener('moumantai:devmodeoptin', read)
      window.removeEventListener('storage', read)
    }
  }, [])

  return (
    <div className={styles.root}>
      {devAvailable && (
        <div className={styles.tabPill} role="tablist" aria-label="Chat or Dev">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'chat'}
            className={`${styles.tabBtn} ${activeTab === 'chat' ? styles.tabActive : ''}`}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'dev'}
            className={`${styles.tabBtn} ${activeTab === 'dev' ? styles.tabActive : ''}`}
            onClick={() => setTab('dev')}
          >
            Dev
          </button>
        </div>
      )}

      {activeTab === 'dev' ? (
        <DevSurface
          appId={appId}
          scope={scope}
          transport={transport}
          connectionStatus={connectionStatus}
          active={active}
        />
      ) : (
        <>
          <div ref={messagesContainerRef} className={styles.messages}>
            {loadOlderState === 'exhausted' && (
              <div className={styles.exhausted}>Beginning of conversation</div>
            )}
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onPlayAudio={
                  msg.role === 'assistant' ? (t) => transport?.sendTTSRequest(t) : undefined
                }
              />
            ))}
            {pending && (
              <div className={styles.thinkingRow}>
                <div className={styles.thinkingBubble}>
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <VoiceIndicator state={voiceState} />
          {voiceError && voiceState === VoiceStateValue.IDLE && (
            <div className={styles.voiceError}>{voiceError}</div>
          )}

          <div className={styles.composer}>
            <ImagePicker
              disabled={connectionStatus !== 'connected' || isCapturing}
              onImage={handleImage}
            />
            <textarea
              ref={textareaRef}
              className={styles.input}
              value={inputText}
              onChange={(e) => setInputText(appId, e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isCapturing ? 'Listening…' : 'Message…'}
              disabled={connectionStatus !== 'connected' || isCapturing}
              rows={1}
            />
            <button
              type="button"
              className={`${styles.iconButton} ${isCapturing ? styles.iconButtonActive : ''}`}
              onClick={onMicTap}
              disabled={connectionStatus !== 'connected'}
              aria-label={isCapturing ? 'Stop voice input' : 'Start voice input'}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden>
                {isCapturing ? 'mic_off' : 'mic'}
              </span>
            </button>
            <button
              type="button"
              className={styles.sendButton}
              onClick={handleSend}
              disabled={!inputText.trim() || connectionStatus !== 'connected'}
              aria-label="Send"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden>
                send
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dev surface — the draft-editing thread.
// ---------------------------------------------------------------------------

interface DevSurfaceProps {
  appId: string
  scope: string
  transport: WebSocketTransport | null
  connectionStatus: string
  /** Whether the dev chat is the currently-viewed app (see ChatScreenProps). */
  active?: boolean
}

const DEV_EMPTY: ChatMessageDisplay[] = []
const EMPTY_TODOS: import('../stores/chat-store').TodoItemDisplay[] = []

/** Status glyph for a checklist row. */
function todoGlyph(status: TodoStatus): string {
  if (status === TodoStatus.COMPLETED) return '✓'
  if (status === TodoStatus.IN_PROGRESS) return '◐'
  return '○'
}

function DevSurface({ appId, scope, transport, connectionStatus, active = true }: DevSurfaceProps) {
  const devKey = `${appId}::dev`
  const messages = useChatStore((s) => s.messagesByApp.get(devKey) ?? DEV_EMPTY)
  const inputText = useChatStore((s) => s.inputTextByApp.get(devKey) ?? '')
  const setInputText = useChatStore((s) => s.setInputText)
  const addMessage = useChatStore((s) => s.addMessage)
  const pending = useChatStore((s) => s.pendingByApp.get(devKey) ?? false)
  const setPending = useChatStore((s) => s.setPending)
  const todos = useChatStore((s) => s.todosByApp.get(devKey) ?? EMPTY_TODOS)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const clearTodos = useChatStore((s) => s.clearTodos)

  const drafts = useAppStore((s) => s.drafts)
  const previewingDraft = useAppStore((s) => s.previewingDraft)
  const setPreviewingDraft = useAppStore((s) => s.setPreviewingDraft)

  const draft = useMemo(
    () =>
      [...drafts.values()].find((d) =>
        appId === 'home' ? d.kind === DraftKind.NEW_APP : d.appId === appId,
      ),
    [drafts, appId],
  )
  const previewing = !!draft && previewingDraft.has(draft.draftId)

  const [actionPending, setActionPending] = useState(false)
  const [confirmingPromote, setConfirmingPromote] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  // Progress card: auto-collapse once every step is done (it's just history
  // then), but let the user override either way. `null` = follow the default.
  const [todosOverride, setTodosOverride] = useState<boolean | null>(null)
  const allTodosDone = todos.length > 0 && todos.every((t) => t.status === TodoStatus.COMPLETED)
  const todosOpen = todosOverride ?? !allTodosDone
  const doneCount = todos.filter((t) => t.status === TodoStatus.COMPLETED).length

  // Identical scroll discipline to the main chat: instant snap to bottom on
  // first content / becoming active (no top-then-animate flash), smooth-scroll
  // for genuinely new messages while viewing.
  const devMessagesRef = useRef<HTMLDivElement>(null)
  const didInitialScrollRef = useRef(false)
  useLayoutEffect(() => {
    if (!active) {
      didInitialScrollRef.current = false
      return
    }
    if (didInitialScrollRef.current) return
    const el = devMessagesRef.current
    if (el) el.scrollTop = el.scrollHeight
    if (messages.length > 0) didInitialScrollRef.current = true
  }, [active, messages.length])
  useEffect(() => {
    if (!active || !didInitialScrollRef.current) return
    const el = devMessagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, active])

  const placeholder =
    appId === 'home'
      ? 'Describe the app you want to build.'
      : 'Describe what to change in this app.'

  const send = useCallback(() => {
    const text = inputText.trim()
    if (!text || !transport) return
    // `/reset` parity with the normal chat input. With an active draft, route
    // through the same two-tap confirm as the button (don't wipe instantly).
    // With NO draft (S0), just clear the local thread — never send a ChatInput,
    // or the server would create a draft titled "/reset".
    if (text.toLowerCase() === '/reset') {
      setInputText(appId, '', 'dev')
      if (draft) {
        setConfirmingPromote(false)
        setConfirmingReset(true)
      } else {
        clearMessages(appId, 'dev')
        clearTodos(appId)
      }
      return
    }
    // Use the clientMsgId as the optimistic row id so the server's kind=DEV echo
    // reconciles against it (App.tsx onChatMessage) instead of adding a second
    // bubble — and so that echo returns early WITHOUT clearing the pending dots
    // (only the assistant reply, which carries no clientMsgId, clears pending).
    const clientMsgId = crypto.randomUUID()
    addMessage(
      appId,
      {
        id: clientMsgId,
        role: 'user',
        text,
        timestamp: new Date().toISOString(),
        status: 'sending',
      },
      'dev',
    )
    setInputText(appId, '', 'dev')
    setPending(appId, true, 'dev')
    transport.sendChatInput(scope, text, clientMsgId, undefined, undefined, 'dev')
    haptic('light')
  }, [
    appId,
    scope,
    transport,
    inputText,
    draft,
    addMessage,
    setInputText,
    setPending,
    clearMessages,
    clearTodos,
  ])

  // Wrap a draft action promise: disable buttons while pending, surface errors.
  const runAction = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setActionPending(true)
    setActionError(null)
    try {
      const r = await fn()
      if (!r.ok) setActionError(r.error ?? 'action failed')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(false)
    }
  }, [])

  const onPreviewToggle = () => {
    if (!transport || !draft) return
    const next = !previewing
    void runAction(() =>
      transport.sendPreviewOptIn(draft.draftId, next).then((r) => {
        if (r.ok) setPreviewingDraft(draft.draftId, next)
        return r
      }),
    )
  }
  const onReload = () => {
    if (transport && draft) void runAction(() => transport.sendDraftReload(draft.draftId))
  }
  const onDiscard = () => {
    if (transport && draft) void runAction(() => transport.sendDraftDiscard(draft.draftId))
  }
  const onStop = () => {
    if (transport && draft) void transport.sendDraftTurnCancel(draft.draftId)
  }
  const onPromote = () => {
    if (!transport || !draft) return
    if (!confirmingPromote) {
      setConfirmingReset(false)
      setConfirmingPromote(true)
      return
    }
    setConfirmingPromote(false)
    void runAction(() => transport.sendDraftPromote(draft.draftId))
  }
  // Reset the dev thread: archive server-side + start fresh, KEEPING the draft.
  // Two-tap like Promote; the second tap fires the wire reset + optimistic local
  // clear (the server's empty dev chatWindow then covers other devices).
  const onReset = () => {
    if (!transport || !draft) return
    if (!confirmingReset) {
      setConfirmingPromote(false)
      setConfirmingReset(true)
      return
    }
    setConfirmingReset(false)
    transport.sendResetConversation(scope, 'dev')
    clearMessages(appId, 'dev')
    clearTodos(appId)
  }

  return (
    <div className={styles.devRoot}>
      <div className={styles.devBanner}>
        {draft ? (
          <>
            <button
              type="button"
              className={styles.devChip}
              onClick={onPreviewToggle}
              disabled={actionPending || connectionStatus !== 'connected'}
            >
              {previewing ? '✓ Previewing' : 'Preview'}
            </button>
            <button
              type="button"
              className={styles.devChip}
              onClick={onReload}
              disabled={actionPending || connectionStatus !== 'connected'}
            >
              Reload preview
            </button>
            {/* Reset stays enabled during a turn (abort+reset); only blocked
                while a draft action (promote/discard/reload) is mid-flight. */}
            <button
              type="button"
              className={styles.devChip}
              onClick={onReset}
              disabled={actionPending || connectionStatus !== 'connected'}
            >
              Reset thread
            </button>
            <button
              type="button"
              className={`${styles.devChip} ${styles.devDanger}`}
              onClick={onDiscard}
              disabled={actionPending || connectionStatus !== 'connected'}
            >
              Discard
            </button>
          </>
        ) : (
          <span className={styles.devHint}>Describe a change to start a draft.</span>
        )}
      </div>

      {confirmingReset && (
        <div className={styles.readyPanel}>
          <p className={styles.readyWarn}>
            Clear this build conversation? Your draft and code are kept.
          </p>
          <div className={styles.readyActions}>
            <button type="button" className={styles.promoteBtn} onClick={onReset}>
              Confirm reset
            </button>
            <button
              type="button"
              className={styles.devChip}
              onClick={() => setConfirmingReset(false)}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}

      {/* Promote is gated on `previewable` (the draft boots/renders), NOT on
          `readyForReview`: if you can preview it, you can promote it. The
          agent's validator pass (`readyForReview`) only adds a "Validated"
          badge + its summary. This survives reconnect and extra chat. */}
      {draft?.previewable && (
        <div className={styles.readyPanel}>
          {draft.readyForReview && (
            <p className={styles.readyBadge}>✓ Validated — ready to promote</p>
          )}
          {draft.summary && (
            <>
              <p
                className={`${styles.readySummary} ${summaryExpanded ? '' : styles.readySummaryClamped}`}
              >
                {draft.summary}
              </p>
              <button
                type="button"
                className={styles.moreBtn}
                onClick={() => setSummaryExpanded((v) => !v)}
              >
                {summaryExpanded ? 'Show less' : 'Show more'}
              </button>
            </>
          )}
          {confirmingPromote && (
            <p className={styles.readyWarn}>
              Promoting replaces the live app for everyone; preview-only data is discarded.
            </p>
          )}
          <div className={styles.readyActions}>
            <button
              type="button"
              className={styles.promoteBtn}
              onClick={onPromote}
              disabled={actionPending || pending}
            >
              {confirmingPromote ? 'Confirm promote' : 'Promote'}
            </button>
            {confirmingPromote && (
              <button
                type="button"
                className={styles.devChip}
                onClick={() => setConfirmingPromote(false)}
              >
                Keep editing
              </button>
            )}
          </div>
          {pending && !confirmingPromote && (
            <p className={styles.devHint}>Finish the in-progress edit before promoting.</p>
          )}
        </div>
      )}

      {todos.length > 0 && (
        <div className={styles.todosCard}>
          <button
            type="button"
            className={styles.todosTitle}
            aria-expanded={todosOpen}
            onClick={() => setTodosOverride(!todosOpen)}
          >
            <span className={styles.todosChevron} aria-hidden>
              {todosOpen ? '▾' : '▸'}
            </span>
            Progress
            <span className={styles.todosCount}>
              {doneCount}/{todos.length}
            </span>
          </button>
          {todosOpen && (
            <ul className={styles.todosList}>
              {todos.map((t, i) => (
                <li
                  key={i}
                  className={`${styles.todoRow} ${t.status === TodoStatus.COMPLETED ? styles.todoDone : ''} ${t.status === TodoStatus.IN_PROGRESS ? styles.todoActive : ''}`}
                >
                  <span className={styles.todoGlyph} aria-hidden>
                    {todoGlyph(t.status)}
                  </span>
                  <span className={styles.todoText}>
                    {t.status === TodoStatus.IN_PROGRESS ? t.activeForm : t.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div ref={devMessagesRef} className={styles.messages}>
        {messages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        {actionError && <div className={styles.devError}>{actionError}</div>}
        {pending && (
          <div className={styles.thinkingRow}>
            <div className={styles.thinkingBubble}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </div>
            <button type="button" className={styles.stopBtn} onClick={onStop}>
              Stop
            </button>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={inputText}
          onChange={(e) => setInputText(appId, e.target.value, 'dev')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={placeholder}
          disabled={connectionStatus !== 'connected'}
          rows={1}
        />
        <button
          type="button"
          className={styles.sendButton}
          onClick={send}
          disabled={!inputText.trim() || connectionStatus !== 'connected'}
          aria-label="Send to edit-agent"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden>
            send
          </span>
        </button>
      </div>
    </div>
  )
}
