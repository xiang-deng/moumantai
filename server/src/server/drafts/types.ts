/**
 * Shared draft types: on-disk metadata, validator error shape, action outcome.
 */

export type DraftKindStr = 'edit' | 'new-app'

/**
 * `<draft>/.meta.json` — server-owned draft metadata. `kind` uses the
 * lowercase string-literal values; conversion to the proto `DraftKind` enum
 * happens when building a `DraftSummary` for the wire.
 */
export interface DraftMeta {
  draftId: string
  /** Live appId for edit drafts; the draftId placeholder then the agent-chosen
   *  manifest.id for new-app drafts. */
  appId: string
  kind: DraftKindStr
  createdAt: number
  msgCount: number
  readyForReview: boolean
  summary?: string
  /** Last dev-chat message time — kept for a possible future janitor; drafts never auto-expire. */
  lastMsgAt?: number
}

/** Canonical validator error shape (validate_face / validate_tool /
 *  generate_migration / request_promote_review all use this). */
export interface ValidationError {
  /** face_id / tool_name / schema-file / 'typecheck' identifier. */
  target: string
  kind: 'face' | 'tool' | 'schema' | 'typecheck'
  message: string
  line?: number
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }

/** Internal outcome of a draft action; the WS layer maps it to the wire
 *  `DraftActionResult { draft_id, ok, error? }`. */
export type DraftActionOutcome = { ok: true } | { ok: false; error: string }
