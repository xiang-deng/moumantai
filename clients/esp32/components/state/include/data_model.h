#pragma once

#include "cJSON.h"
#include "esp_err.h"

/**
 * Resolve a JSON Pointer path (RFC 6901) against a cJSON object.
 *
 * @param root    Root cJSON object
 * @param pointer JSON Pointer string, e.g. "/summary/total" or "/expenses/0/amount"
 * @return Borrowed cJSON reference (do NOT free), or NULL if path not found
 */
cJSON *data_model_resolve(const cJSON *root, const char *pointer);

/**
 * Resolve a dynamic value — if it's a {path: "..."} object, resolve the path.
 * If it's a literal, return it directly.
 *
 * Handles:
 *   - {path: "/absolute/path"} → resolve from root_data
 *   - {path: "relative"} or {path: "$.relative"} → resolve from item_scope
 *   - literal value → return as-is
 *
 * @param value           The cJSON value to resolve (may be pathRef or literal)
 * @param root_data       Face data model root
 * @param item_scope_path JSON Pointer to current list item (NULL at top level)
 * @return Borrowed cJSON reference, or the literal value itself
 */
cJSON *data_model_resolve_dynamic(const cJSON *value, const cJSON *root_data, const char *item_scope_path);

/**
 * Set a value at a JSON Pointer path in the data model.
 * Creates intermediate objects/arrays as needed.
 *
 * @param root    Root cJSON object (modified in place)
 * @param pointer JSON Pointer path
 * @param value   Value to set (duplicated internally)
 * @return ESP_OK on success
 */
esp_err_t data_model_set(cJSON *root, const char *pointer, const cJSON *value);

/**
 * Delete a value at a JSON Pointer path.
 *
 * @param root    Root cJSON object (modified in place)
 * @param pointer JSON Pointer path
 * @return ESP_OK on success, ESP_ERR_NOT_FOUND if path doesn't exist
 */
esp_err_t data_model_delete(cJSON *root, const char *pointer);
