cmake_minimum_required(VERSION 3.22)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# Move LVGL's 128 KB static widget pool from internal SRAM to PSRAM.
#
# Must be set BEFORE project() via idf_build_set_property — ESP-IDF's
# `add_compile_definitions` after the project include doesn't propagate to
# managed components like lvgl__lvgl (which would leave the LVGL pool in
# .dram.bss).
#
# LVGL declares the pool as
#   static MEM_UNIT work_mem_int[...] LV_ATTRIBUTE_LARGE_RAM_ARRAY;
# (managed_components/lvgl__lvgl/src/stdlib/builtin/lv_mem_core_builtin.c).
# EXT_RAM_BSS_ATTR (from esp_attr.h) places the static in .ext_ram.bss,
# which the linker maps into PSRAM when CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y
# (set in sdkconfig.defaults). Frees ~128 KB of our tightest memory tier.
#
# LV_MEM_POOL_INCLUDE is LVGL's hook for force-including a header in the
# pool-allocator file; we use it to pull in esp_attr.h so EXT_RAM_BSS_ATTR
# is visible at macro-expansion time.
#
# Trade-off: paint pipeline reads widget fields through PSRAM cache; on
# ESP32-S3 + SPI ILI9488 this adds ~5-15 % to per-frame paint time. Negligible
# vs. the SPI bandwidth that dominates each LCD flush (~150 ms / full frame
# at 40 MHz). DO NOT apply this attribute to fonts/images — LVGL #9085 shows
# them rendering blank in PSRAM. Those use LV_ATTRIBUTE_LARGE_CONST which we
# leave alone (stays in internal flash/ROM).
idf_build_set_property(COMPILE_DEFINITIONS
    "LV_MEM_POOL_INCLUDE=\"esp_attr.h\""
    APPEND)
idf_build_set_property(COMPILE_DEFINITIONS
    "LV_ATTRIBUTE_LARGE_RAM_ARRAY=EXT_RAM_BSS_ATTR"
    APPEND)

project(moumantai-esp32-client)
