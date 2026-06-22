/**
 * Typed `ServerMessage` envelope builders.
 *
 * Wraps the protobuf-es `create(SchemaDesc, init)` boilerplate so callers
 * construct outbound messages at terse call sites. The WS layer encodes the
 * result via `toBinary(ServerMessageSchema, msg)` at the frame boundary.
 */

import { create } from '@bufbuild/protobuf'
import type { JsonObject } from '@bufbuild/protobuf'
import type {
  ServerMessage,
  ServerHello,
  AppVariant,
  ChatMessage,
  ChatWindowMsg,
  ChatWindowEntry,
  ChatHistoryMsg,
  ChatUpdateMsg,
  ResetNoticeMsg,
  VoiceState,
  AppListMsg,
  AppInfo,
  FaceListMsg,
  FaceInfo,
  FaceUpdateMsg,
  NavigateMsg,
  ErrorMessage,
  UiActionEscalated,
  ComponentDef,
  ChatRole,
  TurnStatus,
  VoiceStateValue,
  ProtocolErrorCode,
  DraftStatus,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  ChatKind,
  TodoStatus,
  ChatTodosUpdateSchema,
  TodoItemSchema,
  DraftKind,
  DraftSummarySchema,
  DraftStateChangedSchema,
  DraftActionResultSchema,
  ServerMessageSchema,
  ServerHelloSchema,
  ChatMessageSchema,
  ChatWindowMsgSchema,
  ChatHistoryMsgSchema,
  ChatWindowEntrySchema,
  ChatUpdateMsgSchema,
  ResetNoticeMsgSchema,
  VoiceStateSchema,
  AppListMsgSchema,
  AppInfoSchema,
  FaceListMsgSchema,
  FaceInfoSchema,
  FaceUpdateMsgSchema,
  NavigateMsgSchema,
  ErrorMessageSchema,
  UiActionEscalatedSchema,
  ChatRole as ChatRoleEnum,
  TurnStatus as TurnStatusEnum,
} from '@moumantai/protocol/generated/moumantai/v1'

// ---------------------------------------------------------------------------
// DB-string → proto-enum boundary
//
// `ChatRole` and `TurnStatus` are stored as text in SQLite (ConversationStore)
// and must be mapped to integer proto enums at the envelope boundary.
// VoiceStateValue / ProtocolErrorCode have no DB persistence — callers
// pass the proto enum directly.
// ---------------------------------------------------------------------------

const CHAT_ROLE_FROM_STRING: Record<string, ChatRole> = {
  user: ChatRoleEnum.USER,
  assistant: ChatRoleEnum.ASSISTANT,
  system: ChatRoleEnum.SYSTEM,
}

const TURN_STATUS_FROM_STRING: Record<string, TurnStatus> = {
  pending: TurnStatusEnum.PENDING,
  running: TurnStatusEnum.RUNNING,
  completed: TurnStatusEnum.COMPLETED,
  failed: TurnStatusEnum.FAILED,
  timed_out: TurnStatusEnum.TIMED_OUT,
  aborted: TurnStatusEnum.ABORTED,
}

function toChatRole(role: string): ChatRole {
  return CHAT_ROLE_FROM_STRING[role] ?? ChatRoleEnum.UNSPECIFIED
}

function toTurnStatus(status: string | undefined): TurnStatus | undefined {
  if (status === undefined) return undefined
  return TURN_STATUS_FROM_STRING[status] ?? undefined
}

/** Coerce an arbitrary record to a typed `google.protobuf.Struct` JsonObject. */
function toStruct(data: Record<string, unknown> | undefined): JsonObject | undefined {
  if (data === undefined || data === null) return undefined
  // protobuf-es accepts JsonObject directly for `google.protobuf.Struct` slots.
  // Cast through unknown to satisfy the JsonObject typing.
  return data as unknown as JsonObject
}

// ---------------------------------------------------------------------------
// Envelope builders — one per server message variant
// ---------------------------------------------------------------------------

export interface HelloOkInit {
  sessionId: string
  devModeEnabled?: boolean
}

export function msgHelloOk(init: HelloOkInit): ServerMessage {
  const value: ServerHello = create(ServerHelloSchema, init)
  return create(ServerMessageSchema, { payload: { case: 'helloOk', value } })
}

export interface ChatInit {
  id: string
  scope: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  timestamp: string
  clientMsgId?: string
  status?: string
  failureReason?: string
  audioUrl?: string
  uiBlocks?: ComponentDef[]
  originDeviceId?: string
  /** Thread kind — 'dev' routes the message to the PWA's dev chat. Unset == chat. */
  kind?: 'chat' | 'dev'
}

export function msgChat(init: ChatInit): ServerMessage {
  const value: ChatMessage = create(ChatMessageSchema, {
    id: init.id,
    scope: init.scope,
    conversationId: init.conversationId,
    role: toChatRole(init.role),
    text: init.text,
    timestamp: init.timestamp,
    clientMsgId: init.clientMsgId,
    status: toTurnStatus(init.status),
    failureReason: init.failureReason,
    audioUrl: init.audioUrl,
    uiBlocks: init.uiBlocks ?? [],
    originDeviceId: init.originDeviceId,
    kind: init.kind === 'dev' ? ChatKind.DEV : init.kind === 'chat' ? ChatKind.CHAT : undefined,
  })
  return create(ServerMessageSchema, { payload: { case: 'chat', value } })
}

export interface ChatWindowEntryInit {
  id: string
  seq: number | bigint
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  // Nullable string fields accept the SQLite-row shape directly.
  // ConversationStore uses `null` for unset columns; proto uses missing
  // optionals. Coerce at the boundary.
  turnMode?: string | null
  source?: string | null
  toolCalls?: unknown
  clientMsgId?: string | null
  status?: string | null
  failureReason?: string | null
  originDeviceId?: string | null
}

function buildEntry(e: ChatWindowEntryInit): ChatWindowEntry {
  // ChatWindowEntry.tool_calls is google.protobuf.Struct (JSON object).
  // Wrap arrays/scalars in `{ entries: ... }`; flat objects pass through.
  const tc = e.toolCalls
  const toolCalls: JsonObject | undefined =
    tc === undefined || tc === null
      ? undefined
      : typeof tc === 'object' && !Array.isArray(tc)
        ? (tc as JsonObject)
        : ({ entries: tc } as unknown as JsonObject)
  return create(ChatWindowEntrySchema, {
    id: e.id,
    seq: typeof e.seq === 'bigint' ? e.seq : BigInt(e.seq),
    role: toChatRole(e.role),
    text: e.text,
    createdAt: e.createdAt,
    turnMode: e.turnMode ?? undefined,
    source: e.source ?? undefined,
    toolCalls,
    clientMsgId: e.clientMsgId ?? undefined,
    status: toTurnStatus(e.status ?? undefined),
    failureReason: e.failureReason ?? undefined,
    originDeviceId: e.originDeviceId ?? undefined,
  })
}

export interface ChatWindowInit {
  scope: string
  conversationId: string
  entries: ChatWindowEntryInit[]
  /** Thread kind — 'dev' replays the window into the PWA dev tab. Unset == chat. */
  kind?: 'chat' | 'dev'
}

export function msgChatWindow(init: ChatWindowInit): ServerMessage {
  const value: ChatWindowMsg = create(ChatWindowMsgSchema, {
    scope: init.scope,
    conversationId: init.conversationId,
    entries: init.entries.map(buildEntry),
    kind: init.kind === 'dev' ? ChatKind.DEV : init.kind === 'chat' ? ChatKind.CHAT : undefined,
  })
  return create(ServerMessageSchema, { payload: { case: 'chatWindow', value } })
}

export interface ChatHistoryInit {
  scope: string
  conversationId: string
  entries: ChatWindowEntryInit[]
  hasMore: boolean
}

export function msgChatHistory(init: ChatHistoryInit): ServerMessage {
  const value: ChatHistoryMsg = create(ChatHistoryMsgSchema, {
    scope: init.scope,
    conversationId: init.conversationId,
    entries: init.entries.map(buildEntry),
    hasMore: init.hasMore,
  })
  return create(ServerMessageSchema, { payload: { case: 'chatHistory', value } })
}

export interface ChatUpdateInit {
  scope: string
  conversationId: string
  id: string
  status: string
  failureReason?: string
  originDeviceId?: string
  /** Thread kind — 'dev' routes the status update to the PWA dev tab. Unset == chat. */
  kind?: 'chat' | 'dev'
}

export function msgChatUpdate(init: ChatUpdateInit): ServerMessage {
  const value: ChatUpdateMsg = create(ChatUpdateMsgSchema, {
    scope: init.scope,
    conversationId: init.conversationId,
    id: init.id,
    status: toTurnStatus(init.status) ?? TurnStatusEnum.UNSPECIFIED,
    failureReason: init.failureReason,
    originDeviceId: init.originDeviceId,
    kind: init.kind === 'dev' ? ChatKind.DEV : init.kind === 'chat' ? ChatKind.CHAT : undefined,
  })
  return create(ServerMessageSchema, { payload: { case: 'chatUpdate', value } })
}

export interface ResetNoticeInit {
  scope: string
  conversationId: string
  requesterSessionId: string
  timestamp: string
}

export function msgResetNotice(init: ResetNoticeInit): ServerMessage {
  const value: ResetNoticeMsg = create(ResetNoticeMsgSchema, init)
  return create(ServerMessageSchema, { payload: { case: 'resetNotice', value } })
}

export interface VoiceStateInit {
  state: VoiceStateValue
}

export function msgVoiceState(init: VoiceStateInit): ServerMessage {
  const value: VoiceState = create(VoiceStateSchema, { state: init.state })
  return create(ServerMessageSchema, { payload: { case: 'voiceState', value } })
}

export interface AppListInit {
  apps: {
    appId: string
    label: string
    icon: string
    position: number
    themeSeed?: string
    /** Live vs. draft variant (unset == LIVE). */
    variant?: AppVariant
    /** Set iff variant == DRAFT. */
    draftId?: string
    /** True for new-app drafts — PWA hides the FAB chat. */
    chatDisabled?: boolean
  }[]
}

export function msgAppList(init: AppListInit): ServerMessage {
  const apps: AppInfo[] = init.apps.map((a) => create(AppInfoSchema, a))
  const value: AppListMsg = create(AppListMsgSchema, { apps })
  return create(ServerMessageSchema, { payload: { case: 'appList', value } })
}

export interface FaceListInit {
  appId: string
  faces: { faceId: string; label: string; position: number }[]
}

export function msgFaceList(init: FaceListInit): ServerMessage {
  const faces: FaceInfo[] = init.faces.map((f) => create(FaceInfoSchema, f))
  const value: FaceListMsg = create(FaceListMsgSchema, { appId: init.appId, faces })
  return create(ServerMessageSchema, { payload: { case: 'faceList', value } })
}

export interface FaceUpdateInit {
  scope: string
  appId: string
  faceId: string
  components: ComponentDef[]
  data?: Record<string, unknown>
  /** Live vs. draft variant (unset == LIVE). Set to DRAFT for preview renders. */
  variant?: AppVariant
}

export function msgFaceUpdate(init: FaceUpdateInit): ServerMessage {
  const value: FaceUpdateMsg = create(FaceUpdateMsgSchema, {
    scope: init.scope,
    appId: init.appId,
    faceId: init.faceId,
    components: init.components,
    data: toStruct(init.data),
    variant: init.variant,
  })
  return create(ServerMessageSchema, { payload: { case: 'faceUpdate', value } })
}

export interface NavigateInit {
  appId: string
  faceId?: string
}

export function msgNavigate(init: NavigateInit): ServerMessage {
  const value: NavigateMsg = create(NavigateMsgSchema, {
    appId: init.appId,
    faceId: init.faceId,
  })
  return create(ServerMessageSchema, { payload: { case: 'navigate', value } })
}

export interface ErrorInit {
  code: ProtocolErrorCode
  message: string
  retryAfterMs?: number
  clientMsgId?: string
}

export function msgError(init: ErrorInit): ServerMessage {
  const value: ErrorMessage = create(ErrorMessageSchema, {
    code: init.code,
    message: init.message,
    retryAfterMs: init.retryAfterMs,
    clientMsgId: init.clientMsgId,
  })
  return create(ServerMessageSchema, { payload: { case: 'error', value } })
}

export interface UiActionEscalatedInit {
  scope: string
}

/** Disposable — not durable, not seq-stamped, not replayed. */
export function msgUiActionEscalated(init: UiActionEscalatedInit): ServerMessage {
  const value: UiActionEscalated = create(UiActionEscalatedSchema, { scope: init.scope })
  return create(ServerMessageSchema, { payload: { case: 'uiActionEscalated', value } })
}

// Every ServerMessage is disposable. Recovery on reconnect goes through
// chatWindow (full snapshot from the persistent SSOT).

// ---------------------------------------------------------------------------
// Draft editing (server → client)
// ---------------------------------------------------------------------------

/** Map the on-disk draft kind string to the proto enum. */
export function draftKindToProto(kind: 'edit' | 'new-app'): DraftKind {
  return kind === 'edit' ? DraftKind.EDIT : DraftKind.NEW_APP
}

export interface DraftSummaryInit {
  draftId: string
  appId: string
  kind: 'edit' | 'new-app'
  createdAtMs: number
  messageCount: number
  readyForReview: boolean
  summary?: string
  /** Promote gate — the draft currently boots/renders. See drafts.proto. */
  previewable: boolean
}

export interface DraftStateChangedInit {
  draft: DraftSummaryInit
  status: DraftStatus
  errorMessage?: string
}

export function msgDraftStateChanged(init: DraftStateChangedInit): ServerMessage {
  const draft = create(DraftSummarySchema, {
    draftId: init.draft.draftId,
    appId: init.draft.appId,
    kind: draftKindToProto(init.draft.kind),
    createdAtMs: BigInt(init.draft.createdAtMs),
    messageCount: init.draft.messageCount,
    readyForReview: init.draft.readyForReview,
    summary: init.draft.summary,
    previewable: init.draft.previewable,
  })
  const value = create(DraftStateChangedSchema, {
    draft,
    status: init.status,
    errorMessage: init.errorMessage,
  })
  return create(ServerMessageSchema, { payload: { case: 'draftStateChanged', value } })
}

export function msgDraftActionResult(init: {
  draftId: string
  ok: boolean
  error?: string
}): ServerMessage {
  const value = create(DraftActionResultSchema, {
    draftId: init.draftId,
    ok: init.ok,
    error: init.error,
  })
  return create(ServerMessageSchema, { payload: { case: 'draftActionResult', value } })
}

// ---------------------------------------------------------------------------
// Chat todos (edit-agent progress card)
// ---------------------------------------------------------------------------

const TODO_STATUS_BY_STRING: Record<'pending' | 'in_progress' | 'completed', TodoStatus> = {
  pending: TodoStatus.PENDING,
  in_progress: TodoStatus.IN_PROGRESS,
  completed: TodoStatus.COMPLETED,
}

export interface ChatTodosUpdateInit {
  scope: string
  conversationId: string
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[]
}

/**
 * Build a `ChatTodosUpdate` (server→client). Always `kind=DEV` — the
 * checklist only exists for the edit-agent's draft conversation.
 */
export function msgChatTodosUpdate(init: ChatTodosUpdateInit): ServerMessage {
  const value = create(ChatTodosUpdateSchema, {
    scope: init.scope,
    conversationId: init.conversationId,
    kind: ChatKind.DEV,
    todos: init.todos.map((t) =>
      create(TodoItemSchema, {
        content: t.content,
        status: TODO_STATUS_BY_STRING[t.status] ?? TodoStatus.PENDING,
        activeForm: t.activeForm,
      }),
    ),
  })
  return create(ServerMessageSchema, { payload: { case: 'chatTodosUpdate', value } })
}

// Re-export for downstream callers (test client, JSON log).
export {
  ServerMessageSchema,
  ClientMessageSchema,
} from '@moumantai/protocol/generated/moumantai/v1'
