import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore, NEIGHBOR_WINDOW } from './renderer/stores/app-store'
import { useConnectionStore } from './stores/connection-store'
import { useToastStore } from './stores/toast-store'
import { useChatStore, type ChatMessageDisplay } from './stores/chat-store'
import { createDispatcher, type DispatchFn } from './renderer/action-dispatcher'
import { RenderNode } from './renderer/RenderNode'
import { AppShell } from './shell/AppShell'
import { FacePager } from './shell/FacePager'
import { StatusHeader } from './shell/StatusHeader'
import { Skeleton } from './shell/Skeleton'
import { Sheet } from './shell/Sheet'
import { BottomChatBar } from './shell/BottomChatBar'
import { ConnectionBanner } from './shell/ConnectionBanner'
import { ChatScreen } from './chat/ChatScreen'
import { SettingsFace } from './settings/SettingsFace'
import { Toast } from './Toast'
import { WebSocketTransport, type SendDroppedKind } from './transport/ws-transport'
import { useAudioPlayback } from './hooks/useAudioPlayback'
import { appIdToScope, scopeToChatKey } from '@moumantai/protocol'
import {
  ChatKind,
  ChatRole,
  DraftStatus,
  DraftKind,
} from '@moumantai/protocol/generated/moumantai/v1'
import { usePaletteStore, MOUMANTAI_SEED } from './theme/palette-store'
import styles from './App.module.css'

type Theme = 'light' | 'dark'

const SEND_DROPPED_MESSAGE: Record<SendDroppedKind, string> = {
  invokeTool: "You're offline — action couldn't be sent. Retry once reconnected.",
  chatInput: "You're offline — message will retry on reconnect.",
  other: "You're offline — request not sent.",
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function roleLabel(role: ChatRole): ChatMessageDisplay['role'] {
  switch (role) {
    case ChatRole.USER:
      return 'user'
    case ChatRole.ASSISTANT:
      return 'assistant'
    case ChatRole.SYSTEM:
      return 'system'
    default:
      return 'assistant'
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transportEpoch, setTransportEpoch] = useState(0)
  const [devModeEnabled, setDevModeEnabled] = useState(false)
  const transportRef = useRef<WebSocketTransport | null>(null)
  const dispatchRef = useRef<DispatchFn | null>(null)
  const setStatus = useConnectionStore((s) => s.setStatus)
  const connectionStatus = useConnectionStore((s) => s.status)

  const appOrder = useAppStore((s) => s.appOrder)
  const apps = useAppStore((s) => s.apps)
  const drafts = useAppStore((s) => s.drafts)
  const previewingDraft = useAppStore((s) => s.previewingDraft)
  const setPreviewingDraft = useAppStore((s) => s.setPreviewingDraft)
  const setChatOverlay = useAppStore((s) => s.setChatOverlay)
  const activeAppIndex = useAppStore((s) => s.activeAppIndex)
  const setActiveAppIndex = useAppStore((s) => s.setActiveAppIndex)
  const setActiveFaceIndex = useAppStore((s) => s.setActiveFaceIndex)
  const { playChunk } = useAudioPlayback()

  useEffect(() => {
    const ws = new WebSocketTransport()
    transportRef.current = ws

    ws.onAudioChunk((data, sampleRate) => playChunk(data, sampleRate))

    ws.onClose(() => {
      setStatus('disconnected')
      // Reset dev-mode; re-established from the next ServerHello.
      // Prevents showing the Dev pill while disconnected or after reconnecting
      // to a server with dev mode off.
      setDevModeEnabled(false)
      useConnectionStore.getState().setError('Disconnected from server. Retrying…')
    })

    ws.onPairingRequired((code) => {
      // Device not yet approved. Show pairing code; transport polls while foregrounded.
      setDevModeEnabled(false)
      useConnectionStore.getState().setPairingCode(code)
      useConnectionStore.getState().setPairingExhausted(false)
      setStatus('pairing')
    })

    ws.onPairingExhausted(() => {
      // Foreground poll burst elapsed — show explicit Retry instead of "connecting".
      useConnectionStore.getState().setPairingExhausted(true)
    })

    ws.onAppList((msg) => useAppStore.getState().setAppList(msg.apps))
    ws.onFaceList((msg) => useAppStore.getState().setFaceList(msg.appId, msg.faces))
    ws.onFaceUpdate((msg) =>
      useAppStore
        .getState()
        .updateFace(
          msg.appId,
          msg.faceId,
          msg.components,
          (msg.data ?? {}) as Record<string, unknown>,
        ),
    )
    ws.onNavigate((msg) => useAppStore.getState().navigateTo(msg.appId, msg.faceId))
    ws.onHelloOk((msg) => {
      setStatus('connected')
      const devOn = msg.devModeEnabled ?? false
      setDevModeEnabled(devOn)
      // Server resets preview opt-ins on every (re)connect — replay persisted
      // opt-ins. Stale drafts (promoted/discarded offline) ACK with ok:false → prune.
      if (devOn) {
        for (const draftId of useAppStore.getState().previewingDraft) {
          void ws.sendPreviewOptIn(draftId, true).then((r) => {
            if (!r.ok) useAppStore.getState().removeDraft(draftId)
          })
        }
      }
    })

    // Chat callbacks
    ws.onChatMessage((msg) => {
      if (msg.role === ChatRole.SYSTEM) return
      const key = scopeToChatKey(msg.scope)
      const kind = msg.kind === ChatKind.DEV ? 'dev' : 'chat'
      const store = useChatStore.getState()
      const role = roleLabel(msg.role)

      // Reconcile optimistic user row by echoed clientMsgId. Returning early
      // preserves the "thinking" indicator — only the assistant reply clears it.
      if (msg.clientMsgId) {
        for (const m of store.getMessages(key, kind)) {
          if (m.id === msg.clientMsgId) {
            store.updateMessage(m.id, { id: msg.id, status: 'sent' })
            return
          }
        }
      }
      store.addMessage(
        key,
        {
          id: msg.id || crypto.randomUUID(),
          role,
          text: msg.text,
          timestamp: msg.timestamp || new Date().toISOString(),
          status: 'sent',
        },
        kind,
      )
      store.setPending(key, false, kind)
      for (const m of store.getMessages(key, kind)) {
        if (m.role === 'user' && m.status === 'sending') {
          store.updateMessage(m.id, { status: 'sent' })
        }
      }
    })
    ws.onChatWindow((msg) => {
      const key = scopeToChatKey(msg.scope)
      const kind = msg.kind === ChatKind.DEV ? 'dev' : 'chat'
      const store = useChatStore.getState()
      store.setConversationId(msg.scope, msg.conversationId, kind)
      store.clearMessages(key, kind)
      for (const e of msg.entries) {
        if (e.role === ChatRole.SYSTEM) continue
        store.addMessage(
          key,
          {
            id: e.id,
            role: roleLabel(e.role),
            text: e.text,
            timestamp: e.createdAt,
            status: 'sent',
          },
          kind,
        )
      }
      store.setPending(key, false, kind)
    })
    ws.onChatHistory((msg) => useChatStore.getState().handleChatHistory(msg))
    ws.onVoiceState((msg) => useChatStore.getState().setVoiceState(msg.state))

    // Edit-agent progress checklist (dev mode).
    ws.onChatTodosUpdate((msg) => {
      const appId = scopeToChatKey(msg.scope)
      useChatStore.getState().setTodos(
        appId,
        msg.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
      )
    })

    // Draft lifecycle (dev mode): CREATED/UPDATED upsert summary; PROMOTED/
    // DISCARDED remove it and prune preview opt-in; FAILED surfaces error toast.
    ws.onDraftStateChanged((m) => {
      if (!m.draft) return
      const store = useAppStore.getState()
      if (m.status === DraftStatus.PROMOTED || m.status === DraftStatus.DISCARDED) {
        store.removeDraft(m.draft.draftId)
        // Clear checklist and dev-chat thread; without this, a fresh edit
        // would append onto stale bubbles from the previous draft.
        const devThreadKey = m.draft.kind === DraftKind.NEW_APP ? 'home' : m.draft.appId
        useChatStore.getState().clearTodos(devThreadKey)
        useChatStore.getState().clearMessages(devThreadKey, 'dev')
        // Promote succeeded → confirm it. Discard is user-initiated, no toast.
        if (m.status === DraftStatus.PROMOTED) {
          useToastStore
            .getState()
            .pushToast(
              'info',
              m.draft.kind === DraftKind.NEW_APP ? 'New app added ✓' : `${m.draft.appId} updated ✓`,
            )
        }
      } else {
        store.upsertDraft(m.draft)
        if (m.status === DraftStatus.FAILED && m.errorMessage) {
          useToastStore.getState().pushToast('error', m.errorMessage)
        }
      }
    })

    // UiActionEscalated — a button tap escalated to a chat clarification.
    // Open the chat overlay and set the pending flag (FAB spins). The pending
    // flag clears when the next ChatMessage/ChatWindow lands; the 30s timer is
    // a fallback if the server's reply never arrives.
    const escalationTimers = new Map<string, ReturnType<typeof setTimeout>>()
    ws.onUiActionEscalated((msg) => {
      const appId = scopeToChatKey(msg.scope)
      useChatStore.getState().setPending(appId, true)
      // Home app's screen IS the chat — no overlay to flip.
      if (appId !== 'home') {
        useAppStore.getState().setChatOverlay(appId, true)
      }
      const existing = escalationTimers.get(appId)
      if (existing) clearTimeout(existing)
      escalationTimers.set(
        appId,
        setTimeout(() => {
          useChatStore.getState().setPending(appId, false)
          escalationTimers.delete(appId)
        }, 30_000),
      )
    })

    ws.onError((err) => {
      useToastStore.getState().pushToast('error', err.message || 'Server error')
      const activeId = useAppStore.getState().getActiveAppId() ?? 'home'
      useChatStore.getState().setPending(scopeToChatKey(appIdToScope(activeId)), false)
    })
    ws.onSendDropped((kind) => {
      useToastStore.getState().pushToast('info', SEND_DROPPED_MESSAGE[kind])
    })

    const dispatcher = createDispatcher(
      (toolName, args, sourceFaceId, clientRequestId, escalationPrompt) => {
        ws.sendInvokeTool(toolName, args, sourceFaceId, clientRequestId, escalationPrompt)
      },
    )
    dispatchRef.current = dispatcher

    setStatus('connecting')
    ws.connect({ width: window.innerWidth, height: window.innerHeight })

    return () => {
      ws.disconnect()
      transportRef.current = null
      dispatchRef.current = null
      useAppStore.getState().reset()
      useChatStore.getState().clearMessages()
      setStatus('disconnected')
    }
  }, [setStatus, playChunk, transportEpoch])

  const dispatch: DispatchFn = useCallback((action, surface, sourceId, itemScope) => {
    dispatchRef.current?.(action, surface, sourceId, itemScope)
  }, [])

  const handleActiveAppChange = useCallback(
    (index: number) => {
      setActiveAppIndex(index)
      // Drop face content outside the proximity window; server prefetch
      // re-fills the new neighbors after `sendViewing` lands.
      useAppStore.getState().evictInactiveApps(index, NEIGHBOR_WINDOW)
      const appId = appOrder[index]
      if (appId) {
        transportRef.current?.sendViewing(appIdToScope(appId))
      }
    },
    [appOrder, setActiveAppIndex],
  )

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('moumantai.theme', next)
    setTheme(next)
  }, [theme])

  const handleReconnect = useCallback(() => {
    setSettingsOpen(false)
    setTransportEpoch((e) => e + 1)
  }, [])

  const refreshActiveApp = useCallback(() => {
    const id = appOrder[activeAppIndex]
    if (id) transportRef.current?.sendViewing(appIdToScope(id))
  }, [appOrder, activeAppIndex])

  // On (re)connect, send `viewing` for the landing app. The server restores
  // the last-active scope and only pushes that scope's chat window, so the
  // PWA's landing app (home, index 0) may get no window until we tell the
  // server what we're actually showing.
  const initialViewSentRef = useRef(false)
  useEffect(() => {
    if (connectionStatus !== 'connected') {
      initialViewSentRef.current = false
      return
    }
    if (initialViewSentRef.current || appOrder.length === 0) return
    initialViewSentRef.current = true
    const id = appOrder[activeAppIndex]
    if (id) transportRef.current?.sendViewing(appIdToScope(id))
  }, [connectionStatus, appOrder.length, activeAppIndex])

  const activeAppId = appOrder[activeAppIndex]
  const activeApp = activeAppId ? apps.get(activeAppId) : undefined

  // Drive the M3 palette from the active app's seed (manifest `color`);
  // falls back to Moumantai indigo. `setActiveSeed` diffs internally.
  useEffect(() => {
    usePaletteStore.getState().setActiveSeed(activeApp?.themeSeed ?? MOUMANTAI_SEED)
  }, [activeAppId, activeApp?.themeSeed])

  return (
    <div className={styles.root}>
      <StatusHeader
        appLabel={activeApp?.label ?? activeAppId}
        onThemeToggle={toggleTheme}
        themeMode={theme}
        onSettingsOpen={() => setSettingsOpen(true)}
      />
      <ConnectionBanner
        onOpenSettings={() => setSettingsOpen(true)}
        onRetryPairing={() => transportRef.current?.retryPairing()}
      />
      {appOrder.length === 0 ? (
        <div className={styles.empty}>
          <Skeleton lines={5} />
        </div>
      ) : (
        <AppShell activeIndex={activeAppIndex} onActiveChange={handleActiveAppChange}>
          {appOrder.map((appId) => {
            const app = apps.get(appId)
            if (!app) return <div key={appId} />
            // Home: full-screen chat. Mini-apps: face pager + bottom chat bar.
            if (appId === 'home') {
              return (
                <ChatScreen
                  key={appId}
                  appId={appId}
                  transport={transportRef.current}
                  devModeEnabled={devModeEnabled}
                  active={activeAppId === appId}
                />
              )
            }
            // Draft preview banner (dev mode): shown when this client is
            // previewing an edit draft; server routes draft faces per-client.
            const previewDraft = [...drafts.values()].find((d) => d.appId === appId)
            const isPreviewing = !!previewDraft && previewingDraft.has(previewDraft.draftId)
            return (
              <div key={appId} className={styles.miniApp}>
                {isPreviewing && previewDraft && (
                  <div className={styles.draftBanner}>
                    <span>Draft preview</span>
                    <button
                      type="button"
                      onClick={() => {
                        transportRef.current?.sendPreviewOptIn(previewDraft.draftId, false)
                        setPreviewingDraft(previewDraft.draftId, false)
                      }}
                    >
                      Live
                    </button>
                    <button type="button" onClick={() => setChatOverlay(appId, true)}>
                      Open Dev chat
                    </button>
                  </div>
                )}
                <FacePager
                  activeIndex={app.activeFaceIndex}
                  onActiveChange={(idx) => setActiveFaceIndex(appId, idx)}
                  onRefresh={refreshActiveApp}
                >
                  {app.faceOrder.length === 0 ? (
                    <Skeleton lines={4} />
                  ) : (
                    app.faceOrder.map((faceId) => (
                      <div key={faceId} className={styles.facePage}>
                        <RenderNode
                          componentId="root"
                          surfaceId={`${appId}:${faceId}`}
                          dispatch={dispatch}
                        />
                      </div>
                    ))
                  )}
                </FacePager>
                <BottomChatBar
                  appId={appId}
                  transport={transportRef.current}
                  devModeEnabled={devModeEnabled}
                />
              </div>
            )
          })}
        </AppShell>
      )}
      <Sheet open={settingsOpen} onDismiss={() => setSettingsOpen(false)} title="Settings">
        <SettingsFace onReconnect={handleReconnect} devModeAvailable={devModeEnabled} />
      </Sheet>
      <Toast />
    </div>
  )
}
