/**
 * Moumantai SDK barrel.
 *
 * Plugin apps import from 'moumantai' and 'moumantai/ui' instead of
 * reaching into framework internals. This file is the resolution
 * target for the bare 'moumantai' specifier (tsconfig paths, vitest alias).
 */

// Builders
export { defineTool } from '../agent/define-tool.js'
export { defineFace } from '../agent/define-face.js'
export { defineWidget } from '../agent/define-widget.js'
export { defineRefreshTask } from '../agent/define-refresh-task.js'
export type {
  Widget,
  WidgetSpec,
  WidgetScope,
  WidgetParamType,
  WidgetParamSpec,
} from '../agent/define-widget.js'

// External-data primitives (viewer-app architecture)
export { secretField } from './secret-field.js'

// DB conventions
export { id, timestamps } from '../db/conventions.js'

// Types
export type {
  AppDefinition,
  ToolDefinition,
  ToolParameter,
  ToolContext,
  ToolResult,
  FaceDefinition,
  FaceResolve,
  FaceBoundRefresh,
  RefreshTaskDefinition,
  RefreshContext,
  RefreshResult,
  HttpClient,
  HttpFetchOptions,
  StalenessRecord,
  AppUpstreamConfig,
} from '../agent/types.js'
export type { AppManifest } from './app-types.js'
export type { ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
