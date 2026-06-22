#include "data_model.h"

#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "esp_log.h"

static const char *TAG = "data_model";

/* --------------------------------------------------------------------------
 * Read-only data-model surface used by the renderer.
 * ESP32 has no local $form; all mutations go through server tool calls.
 * ----------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
 * JSON Pointer resolution (RFC 6901)
 * ----------------------------------------------------------------------- */

cJSON *data_model_resolve(const cJSON *root, const char *pointer) {
    if (!root || !pointer)
        return NULL;
    if (pointer[0] == '\0' || (pointer[0] == '/' && pointer[1] == '\0')) {
        return (cJSON *)root;
    }

    /* Skip leading '/' */
    const char *p = pointer;
    if (*p == '/')
        p++;

    cJSON *current = (cJSON *)root;

    while (*p && current) {
        /* Find the next '/' or end of string */
        const char *next = strchr(p, '/');
        size_t key_len = next ? (size_t)(next - p) : strlen(p);

        /* Extract key (handle ~0 → ~ and ~1 → / escapes) */
        char key[128];
        size_t ki = 0;
        for (size_t i = 0; i < key_len && ki < sizeof(key) - 1; i++) {
            if (p[i] == '~' && i + 1 < key_len) {
                if (p[i + 1] == '1') {
                    key[ki++] = '/';
                    i++;
                    continue;
                }
                if (p[i + 1] == '0') {
                    key[ki++] = '~';
                    i++;
                    continue;
                }
            }
            key[ki++] = p[i];
        }
        key[ki] = '\0';

        if (cJSON_IsArray(current)) {
            int idx = atoi(key);
            current = cJSON_GetArrayItem(current, idx);
        } else if (cJSON_IsObject(current)) {
            current = cJSON_GetObjectItem(current, key);
        } else {
            return NULL;
        }

        p = next ? next + 1 : p + key_len;
    }

    return current;
}

/* --------------------------------------------------------------------------
 * Dynamic value resolution
 * ----------------------------------------------------------------------- */

cJSON *data_model_resolve_dynamic(const cJSON *value, const cJSON *root_data, const char *item_scope_path) {
    if (!value)
        return NULL;

    /* Check if value is a pathRef: {"path": "..."} */
    if (cJSON_IsObject(value)) {
        cJSON *path_item = cJSON_GetObjectItem(value, "path");
        if (path_item && cJSON_IsString(path_item)) {
            const char *path = path_item->valuestring;

            /* Absolute path */
            if (path[0] == '/') {
                return data_model_resolve(root_data, path);
            }

            /* Relative path — strip $. prefix if present */
            if (path[0] == '$' && path[1] == '.') {
                path += 2;
            }

            /* Build full path: item_scope_path + "/" + relative */
            if (item_scope_path) {
                char full_path[256];
                snprintf(full_path, sizeof(full_path), "%s/%s", item_scope_path, path);
                return data_model_resolve(root_data, full_path);
            }

            /* No item scope — try as root-relative */
            char full_path[256];
            snprintf(full_path, sizeof(full_path), "/%s", path);
            return data_model_resolve(root_data, full_path);
        }
    }

    /* Not a pathRef — return the literal value itself */
    return (cJSON *)value;
}

/* --------------------------------------------------------------------------
 * Set/Delete at JSON Pointer
 * ----------------------------------------------------------------------- */

esp_err_t data_model_set(cJSON *root, const char *pointer, const cJSON *value) {
    if (!root || !pointer || pointer[0] != '/')
        return ESP_ERR_INVALID_ARG;

    /* Find the parent and the final key */
    const char *last_slash = strrchr(pointer, '/');
    if (!last_slash)
        return ESP_ERR_INVALID_ARG;

    cJSON *parent;
    if (last_slash == pointer) {
        /* Path is "/key" — parent is root */
        parent = root;
    } else {
        /* Path is "/a/b/key" — resolve parent "/a/b" */
        char parent_path[256];
        size_t parent_len = (size_t)(last_slash - pointer);
        if (parent_len >= sizeof(parent_path))
            return ESP_ERR_INVALID_SIZE;
        memcpy(parent_path, pointer, parent_len);
        parent_path[parent_len] = '\0';
        parent = data_model_resolve(root, parent_path);
    }

    if (!parent)
        return ESP_ERR_NOT_FOUND;

    const char *key = last_slash + 1;
    cJSON *dup = cJSON_Duplicate(value, true);
    if (!dup)
        return ESP_ERR_NO_MEM;

    if (cJSON_IsArray(parent)) {
        int idx = atoi(key);
        cJSON_ReplaceItemInArray(parent, idx, dup);
    } else if (cJSON_IsObject(parent)) {
        if (cJSON_HasObjectItem(parent, key)) {
            cJSON_ReplaceItemInObject(parent, key, dup);
        } else {
            cJSON_AddItemToObject(parent, key, dup);
        }
    } else {
        cJSON_Delete(dup);
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

esp_err_t data_model_delete(cJSON *root, const char *pointer) {
    if (!root || !pointer || pointer[0] != '/')
        return ESP_ERR_INVALID_ARG;

    const char *last_slash = strrchr(pointer, '/');
    if (!last_slash)
        return ESP_ERR_INVALID_ARG;

    cJSON *parent;
    if (last_slash == pointer) {
        parent = root;
    } else {
        char parent_path[256];
        size_t parent_len = (size_t)(last_slash - pointer);
        if (parent_len >= sizeof(parent_path))
            return ESP_ERR_INVALID_SIZE;
        memcpy(parent_path, pointer, parent_len);
        parent_path[parent_len] = '\0';
        parent = data_model_resolve(root, parent_path);
    }

    if (!parent)
        return ESP_ERR_NOT_FOUND;

    const char *key = last_slash + 1;
    if (cJSON_IsArray(parent)) {
        cJSON_DeleteItemFromArray(parent, atoi(key));
    } else if (cJSON_IsObject(parent)) {
        cJSON_DeleteItemFromObject(parent, key);
    }

    return ESP_OK;
}
