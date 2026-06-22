/**
 * SDK pattern library — domain-agnostic compositions over primitives.
 *
 * Patterns are static functions emitting `ComponentDef[]`. They do not branch
 * on form-factor; that split lives in the face file convention
 * (`<id>.compact.ts` / `<id>.expanded.ts`) and renderer-side design-system
 * rules.
 *
 * Bar for a new pattern: ≥2 apps need it.
 *
 * v1 set: hero, kpi, emptyState, actionRow, detailHeader, sectionHeader,
 * statusBadge, loadMore.
 */

export { hero } from './hero.js'
export { kpi, type KpiOptions } from './kpi.js'
export { emptyState, type EmptyStateOptions } from './empty-state.js'
export { actionRow, type ActionRowSpec } from './action-row.js'
export { detailHeader, type DetailHeaderOptions } from './detail-header.js'
export { sectionHeader, type SectionHeaderOptions } from './section-header.js'
export { statusBadge, type StatusBadgeOptions } from './status-badge.js'
export { loadMore, type LoadMoreOptions } from './load-more.js'
