#pragma once

/*
 * render_node.h — typed-protobuf component renderer.
 *
 * Renderers consume `moumantai_v1_*Component` structs directly (no cJSON tree
 * in the component-tree code path). The face data model is still cJSON
 * because `FaceUpdateMsg.data` is `google.protobuf.Struct` — for value
 * resolution see `data_model_resolve` / `data_model_resolve_dynamic`.
 *
 * Free-form string fields (typography, color, font_weight, button/chip/card
 * variant, image_fit, alignments, keyboard_type, picker_mode, progress
 * variant) are pre-allocated as `char[N]` via `nanopb.options max_size:N`,
 * so they read as plain `const char*` with the matching `has_*` flag.
 */

#include "lvgl.h"
#include "cJSON.h"
#include "moumantai/v1/components.pb.h"
#include "moumantai/v1/dynamic.pb.h"

/* Forward declaration — defined in render_node.c. Carried in render_ctx_t so
 * renderers can detect "I'm running in a batched session; queue grandchildren
 * for a later tick instead of recursing through them now." */
typedef struct render_session_s render_session_t;

/* --------------------------------------------------------------------------
 * Render context — passed through the recursive component tree.
 * ----------------------------------------------------------------------- */

typedef struct {
    const moumantai_v1_ComponentDef *components; /* face's typed component list */
    int num_components;
    const cJSON *data;            /* face data model (Struct → cJSON) */
    const char *surface_id;       /* "appId:faceId" */
    const char *item_scope_path;  /* JSON Pointer to list item */
    const cJSON *item_scope_data; /* resolved item cJSON */
    /* Non-NULL when the renderer is running under a batched session.
     * render_children_ids and render_list check this and enqueue grandchildren
     * instead of recursing. Layout-affecting renderers (Box, ListItem trailing)
     * keep their render_node calls synchronous — render_node still creates +
     * returns the widget while queueing only its grandchildren. */
    render_session_t *session;
    /* component_id -> cJSON args sidecar (per-face, populated by proto_decode
     * when Action.args is on the wire). wire_action looks up by component_id
     * to attach the args to the click handler so they round-trip back to the
     * server in InvokeToolMsg.args. NULL when no actions on this face have
     * args. */
    const cJSON *action_args;
} render_ctx_t;

/* --------------------------------------------------------------------------
 * Parent descriptor — catalog-driven layout resolver input.
 *
 * Passed to render_node for every child so the catalog's ds_layout_resolve_*
 * functions can determine FILL / WRAP / GROW / FIXED per (parent, child, slot).
 * ----------------------------------------------------------------------- */

typedef struct {
    const char *kind;      /* TypeName of parent ("Column", "Row", "Box", …) or NULL for root */
    int slot_index;        /* 0-based child position; matters for Box positional rule */
    const char *slot_name; /* Scaffold slot name ("body"/"top_bar"/"fab") or NULL */
} ds_render_parent_t;

/* Convenience sentinel for the top-level root render call. */
#define DS_RENDER_PARENT_ROOT ((ds_render_parent_t){.kind = NULL, .slot_index = 0, .slot_name = NULL})

/* --------------------------------------------------------------------------
 * Top-level render entry point.
 * ----------------------------------------------------------------------- */

/**
 * Find a component by id and render it under `parent`. Returns the LVGL
 * object (NULL if the id is unknown or the component is hidden).
 *
 * `parent_info` describes the container that owns this child slot — used by
 * apply_resolved_size() to drive the catalog layout resolver.  Pass
 * DS_RENDER_PARENT_ROOT for the outermost call.
 */
lv_obj_t *render_node(lv_obj_t *parent, const char *component_id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info);

/**
 * Render a fixed list of children component ids (e.g. Column.children).
 * `parent_kind` is the TypeName of the container (e.g. "Column") used to
 * compute each child's ds_render_parent_t (slot_index auto-increments).
 *
 * When ctx->session is non-NULL, children are appended to the session's work
 * queue (BFS) rather than recursed into synchronously. Each queue entry
 * inherits ctx->item_scope_data so list-item context survives the deferral.
 */
void render_children_ids(lv_obj_t *parent, const char (*children)[64], int count, const render_ctx_t *ctx,
                         const char *parent_kind);

/* --------------------------------------------------------------------------
 * Render session — batched continuation API. Owned by renderer.c; renderers
 * only ever see render_ctx_t.session as an opaque pointer and call the queue
 * helpers below. Implementation lives in render_node.c next to the BFS logic.
 * ----------------------------------------------------------------------- */

/** Append a child component to the session queue with optional post-op
 *  metadata. parent must still be a valid lv_obj_t* when the entry fires;
 *  the worker checks lv_obj_is_valid before rendering. item_scope_data is
 *  borrowed from the snapshot cJSON tree and must outlive the session. */
typedef enum {
    RPS_POST_NONE = 0,
    RPS_POST_ALIGN,          /* lv_obj_align(widget, align, 0, 0) after render */
    RPS_POST_SIZE_CONTENT_W, /* lv_obj_set_width(widget, LV_SIZE_CONTENT) */
} render_session_post_op_t;

void render_session_queue(render_session_t *session, lv_obj_t *parent, const char *child_id,
                          ds_render_parent_t parent_info, const cJSON *item_scope_data,
                          render_session_post_op_t post_op, lv_align_t post_align);

/** Whether the session has remaining work. */
bool render_session_has_work(const render_session_t *session);

/** Drain entries from the queue until the wall-clock budget expires OR the
 *  queue is empty. The ctx_template's components/data/surface_id are reused
 *  for each entry; item_scope_data is overwritten per entry. */
void render_session_drain_batch(render_session_t *session, const render_ctx_t *ctx_template, int64_t budget_us);

/** Allocate + initialize. Caller fills in members afterwards. */
render_session_t *render_session_create(void);

/** Free the session and any remaining queue entries (does NOT drain — the
 *  caller decides whether to drain face_free). */
void render_session_destroy(render_session_t *session);

/* --------------------------------------------------------------------------
 * Component lookup
 * ----------------------------------------------------------------------- */

const moumantai_v1_ComponentDef *find_component(const moumantai_v1_ComponentDef *comps, int count, const char *id);

/* --------------------------------------------------------------------------
 * DynamicString / DynamicBool / DynamicDouble / DynamicInt32 resolvers.
 *
 * Each resolves the typed wrapper against the surrounding data model (root
 * + item_scope_path). When the wrapper is a `path`, we look it up via JSON
 * Pointer; when it's a `literal`, we return the literal value.
 *
 * The DynamicString resolver returns a borrowed `const char*`; for
 * resolved-from-data values that are numbers/bools, it stringifies into
 * a thread-local scratch buffer (the renderer is single-threaded inside
 * the LVGL task, so this is safe).
 * ----------------------------------------------------------------------- */

/** Returns the resolved string, or NULL if not present. Caller does not free. */
const char *dyn_string_resolve(const moumantai_v1_DynamicString *ds, const render_ctx_t *ctx);

/** Returns the resolved bool, or `fallback` if the dynamic value is unset. */
bool dyn_bool_resolve(const moumantai_v1_DynamicBool *db, const render_ctx_t *ctx, bool fallback);

/** Returns the resolved double, or `fallback` if unset. */
double dyn_double_resolve(const moumantai_v1_DynamicDouble *dd, const render_ctx_t *ctx, double fallback);

/** Returns the resolved int32, or `fallback` if unset. */
int32_t dyn_int32_resolve(const moumantai_v1_DynamicInt32 *di, const render_ctx_t *ctx, int32_t fallback);

/* --------------------------------------------------------------------------
 * Modifier application — common props every component carries.
 * ----------------------------------------------------------------------- */

/** Apply padding/width/height/weight/background/visible from a Modifier. */
void apply_modifier(lv_obj_t *obj, const moumantai_v1_Modifier *mod, const render_ctx_t *ctx);

/** Visibility check — returns false if the component should be skipped. */
bool modifier_visible(const moumantai_v1_Modifier *mod, const render_ctx_t *ctx);
