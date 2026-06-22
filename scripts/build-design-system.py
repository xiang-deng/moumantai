#!/usr/bin/env python3
"""Generate per-language design-system catalogs from the YAML SSOT.

Source : shared/protocol/design-system/design-system.yaml
Outputs:
  - shared/protocol/design-system/generated/design-system.ts
  - shared/protocol/design-system/generated/DesignSystem.kt
  - shared/protocol/design-system/generated/design_system.h
  - shared/protocol/design-system/generated/design_system.c
  - shared/protocol/design-system/generated/design-system.css

Usage: uv run python scripts/build-design-system.py [--check]

`--check` re-runs the generation and fails if any committed output differs.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
YAML_PATH = ROOT / "shared" / "protocol" / "design-system" / "design-system.yaml"
OUT_DIR = ROOT / "shared" / "protocol" / "design-system" / "generated"
COMPONENTS_PROTO = (
    ROOT / "shared" / "protocol" / "proto" / "moumantai" / "v1" / "components.proto"
)

HEADER = "AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND."


# Per-(kind, accent) Material 3 color token triples used by the CSS emitter.
# `accent: neutral` keeps surface-tone backgrounds; any other accent uses the
# matching color/on-color/container/on-container roles. Renderers translate
# the same (kind, accent) pair to their native equivalents (Compose
# colorScheme, LVGL theme, ...).
def css_rules_for(kind: str, accent: str) -> dict[str, str]:
    """Return CSS declarations for a (kind, accent) pair.

    Returned dict keys are CSS property names (e.g. 'background', 'color',
    'border', 'box-shadow'); values are full property values (already
    `var(--...)`-wrapped where appropriate).
    """
    is_neutral = accent == "neutral"
    if kind == "filled_container":
        if is_neutral:
            return {
                "background": "var(--md-sys-color-surface-container-highest)",
                "color": "var(--md-sys-color-on-surface)",
            }
        return {
            "background": f"var(--md-sys-color-{accent})",
            "color": f"var(--md-sys-color-on-{accent})",
        }
    if kind == "elevated_container":
        return {
            "background": "var(--md-sys-color-surface-container-low)",
            "color": "var(--md-sys-color-on-surface)",
            "box-shadow": "0 1px 3px rgba(0,0,0,0.3)",
        }
    if kind == "outlined_container":
        return {
            "background": "var(--md-sys-color-surface)",
            "color": (
                "var(--md-sys-color-on-surface)"
                if is_neutral
                else f"var(--md-sys-color-{accent})"
            ),
            "border": "1px solid var(--md-sys-color-outline-variant)",
        }
    if kind == "transparent":
        return {
            "background": "transparent",
            "color": (
                "var(--md-sys-color-on-surface)"
                if is_neutral
                else f"var(--md-sys-color-{accent})"
            ),
        }
    if kind == "floating_action":
        return {
            "background": f"var(--md-sys-color-{accent}-container)",
            "color": f"var(--md-sys-color-on-{accent}-container)",
        }
    if kind in ("progress_ring", "progress_bar"):
        return {
            "color": (
                "var(--md-sys-color-primary)"
                if is_neutral
                else f"var(--md-sys-color-{accent})"
            ),
        }
    return {}


def load_catalog() -> dict[str, Any]:
    with open(YAML_PATH, "r", encoding="utf-8") as f:
        catalog = yaml.safe_load(f)
    _normalize_treatments(catalog)
    return catalog


def _normalize_treatments(catalog: dict[str, Any]) -> None:
    """Synthesize `variants` + `default_variant` from the `treatments` list.

    Each component's treatments list maps (match → kind, accent). We synthesize
    the internal `variants` dict from unique (kind, accent) pairs, keyed by
    `<kind>-<accent>`. Authors write intent fields (`emphasis`, `tone`);
    `resolve<Component>Treatment(...)` maps them to the internal key at render time.

    Default variant = the catch-all (empty match), or the last treatment if none.
    """
    for name, comp in catalog["components"].items():
        if not isinstance(comp, dict):
            continue
        if "treatments" not in comp:
            continue
        treatments = comp["treatments"]
        if not isinstance(treatments, list) or not treatments:
            raise SystemExit(
                f"ERROR: components.{name}.treatments must be a non-empty list"
            )
        variants: dict[str, dict[str, str]] = {}
        for t in treatments:
            key = _treatment_key(t["kind"], t["accent"])
            if key not in variants:
                variants[key] = {"kind": t["kind"], "accent": t["accent"]}
        comp["variants"] = variants
        catch_all = next(
            (t for t in treatments if not t.get("match")),
            treatments[-1],
        )
        comp["default_variant"] = _treatment_key(catch_all["kind"], catch_all["accent"])


def _treatment_key(kind: str, accent: str) -> str:
    """Internal-only variant identifier: `<kind>-<accent>`."""
    return f"{kind}-{accent}"


# Proto-vs-catalog validation — every ComponentDef.component variant MUST have a
# layout.components.<Name> row. Codegen fails closed so new proto components can't
# ship without a layout-default rule.

# Matches lines inside `oneof component { ... }` like:
#   TextComponent text = 10;
#   BoxComponent box = 23;
_ONEOF_BODY_RE = re.compile(
    r"oneof\s+component\s*\{(.+?)\}",
    re.DOTALL,
)
_FIELD_RE = re.compile(r"\b(\w+)Component\s+\w+\s*=\s*\d+\s*;")


def proto_component_names() -> list[str]:
    """Return the variant TypeName list from ComponentDef.component oneof."""
    text = COMPONENTS_PROTO.read_text(encoding="utf-8")
    body_match = _ONEOF_BODY_RE.search(text)
    if not body_match:
        raise SystemExit(
            f"Could not find `oneof component {{ ... }}` in {COMPONENTS_PROTO}"
        )
    return sorted(_FIELD_RE.findall(body_match.group(1)))


def validate_layout(catalog: dict[str, Any]) -> None:
    """Cross-check the layout block against the proto's ComponentDef oneof.

    Fails closed if a proto variant lacks a `layout.components.<Name>` entry,
    or if `layout.components` lists a name that isn't a proto variant.
    """
    layout = catalog.get("layout")
    if layout is None:
        raise SystemExit("design-system.yaml is missing the `layout:` block")

    proto_names = set(proto_component_names())
    catalog_names = set(layout.get("components", {}).keys())

    missing = sorted(proto_names - catalog_names)
    if missing:
        raise SystemExit(
            "ERROR: design-system.yaml `layout.components` is missing entries "
            "for proto variants:\n  "
            + "\n  ".join(missing)
            + "\nAdd a `<Name>: { width: <kind>, height: <kind> }` row."
        )

    extra = sorted(catalog_names - proto_names)
    if extra:
        raise SystemExit(
            "ERROR: design-system.yaml `layout.components` lists names "
            "absent from the proto:\n  " + "\n  ".join(extra)
        )

    # Sanity-check container entries reference real components.
    for cname in layout.get("containers", {}).keys():
        if cname not in proto_names:
            raise SystemExit(
                f"ERROR: `layout.containers.{cname}` is not a proto variant"
            )
    # `variant_overrides` must live nested under each component:
    # `layout.components.<Name>.variant_overrides.<variant>`. Reject a stray
    # top-level entry — that shape is not supported.
    if "variant_overrides" in layout:
        raise SystemExit(
            "ERROR: top-level `layout.variant_overrides` was moved to "
            "per-component `layout.components.<Name>.variant_overrides`. "
            "Update design-system.yaml."
        )

    # Per-component `compact:` block is an additive authoring-hint surface
    # consumed by defineFace compact-discipline guards (TS-side). Each entry
    # must be a flat dict of scalar hints; unknown keys are rejected so
    # future hints land via a deliberate schema change here.
    COMPACT_ALLOWED_KEYS = {
        "max_circular_size_dp",
        "orientation_hint",
        "max_selected_chips",
        "max_body_children",
    }
    for cname, comp in (layout.get("components") or {}).items():
        if not isinstance(comp, dict):
            continue
        compact = comp.get("compact")
        if compact is None:
            continue
        if not isinstance(compact, dict):
            raise SystemExit(
                f"ERROR: `layout.components.{cname}.compact` must be a mapping"
            )
        for key in compact:
            if key not in COMPACT_ALLOWED_KEYS:
                raise SystemExit(
                    f"ERROR: `layout.components.{cname}.compact.{key}` is not "
                    f"a recognized compact hint. Allowed keys: "
                    f"{sorted(COMPACT_ALLOWED_KEYS)}. Add it to "
                    f"COMPACT_ALLOWED_KEYS in scripts/build-design-system.py "
                    f"after wiring a TS consumer."
                )


# Sorting helpers — alphabetical order for commit-stable output.


def sorted_components(catalog: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return sorted(catalog["components"].items(), key=lambda kv: kv[0])


def sorted_variants(comp: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    variants = comp.get("variants", {})
    return sorted(variants.items(), key=lambda kv: kv[0])


# TypeScript output


def emit_ts(catalog: dict[str, Any]) -> str:
    lines: list[str] = [
        f"// {HEADER}",
        f"// Source: shared/protocol/design-system/design-system.yaml",
        "",
        "export interface VariantSpec {",
        "  readonly kind: string",
        "  readonly accent: string",
        "}",
        "",
        "export interface ComponentSpec {",
        "  readonly defaultVariant: string",
        "  readonly variants: Readonly<Record<string, VariantSpec>>",
        "}",
        "",
        "export interface ImageSpec {",
        "  readonly defaultFit: string",
        "  readonly fitModes: readonly string[]",
        "  readonly fitAliases: Readonly<Record<string, string>>",
        "}",
        "",
        "export interface AlignmentsSpec {",
        "  readonly default: string",
        "  readonly values: readonly string[]",
        "}",
        "",
        "export interface ArrangementsSpec {",
        "  readonly default: string",
        "  readonly values: readonly string[]",
        "}",
        "",
    ]

    # DESIGN_SYSTEM literal
    lines.append("export const DESIGN_SYSTEM = {")
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue  # handled separately for type clarity
        lines.append(f"  {name}: {{")
        lines.append(f"    defaultVariant: {json_str(comp['default_variant'])},")
        lines.append("    variants: {")
        for vname, v in sorted_variants(comp):
            lines.append(
                f"      {ts_key(vname)}: {{ kind: {json_str(v['kind'])}, "
                f"accent: {json_str(v['accent'])} }},"
            )
        lines.append("    },")
        lines.append("  },")
    # Image
    img = catalog["components"]["Image"]
    lines.append("  Image: {")
    lines.append(f"    defaultFit: {json_str(img['default_fit'])},")
    fit_modes_str = ", ".join(json_str(m) for m in sorted(img["fit_modes"]))
    lines.append(f"    fitModes: [{fit_modes_str}] as const,")
    lines.append("    fitAliases: {")
    for alias in sorted(img["fit_aliases"].keys()):
        lines.append(f"      {ts_key(alias)}: {json_str(img['fit_aliases'][alias])},")
    lines.append("    },")
    lines.append("  },")
    lines.append("} as const")
    lines.append("")

    # Alignments
    al = catalog["alignments"]
    lines.append("export const ALIGNMENTS: AlignmentsSpec = {")
    lines.append(f"  default: {json_str(al['default'])},")
    al_values_str = ", ".join(json_str(v) for v in sorted(al["values"]))
    lines.append(f"  values: [{al_values_str}],")
    lines.append("}")
    lines.append("")

    # Arrangements
    arr = catalog.get("arrangements")
    if arr:
        lines.append("export const ARRANGEMENTS: ArrangementsSpec = {")
        lines.append(f"  default: {json_str(arr['default'])},")
        arr_values_str = ", ".join(json_str(v) for v in arr["values"])
        lines.append(f"  values: [{arr_values_str}],")
        lines.append("}")
        lines.append("")

    # IMAGE_FIT_ALIASES top-level export for ergonomics
    lines.append("export const IMAGE_FIT_ALIASES: Readonly<Record<string, string>> =")
    lines.append("  DESIGN_SYSTEM.Image.fitAliases")
    lines.append("")

    # Per-component resolve(variant) helpers
    lines.append(
        "// ---------------------------------------------------------------------------"
    )
    lines.append(
        "// Resolve helpers — return the VariantSpec for a wire string, falling back"
    )
    lines.append("// to the component's defaultVariant when unset or unknown.")
    lines.append(
        "// ---------------------------------------------------------------------------"
    )
    lines.append("")
    for name, _comp in sorted_components(catalog):
        if name == "Image":
            continue
        var_name = name.lower()
        lines.append(
            f"export function resolve{name}Variant(variant: string | undefined | null): VariantSpec {{"
        )
        lines.append(f"  const c = DESIGN_SYSTEM.{name}")
        lines.append(
            "  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants"
        )
        lines.append(
            "  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]"
        )
        lines.append("}")
        lines.append("")
        lines.append(f"export function {var_name}Variants(): readonly string[] {{")
        lines.append(f"  return Object.keys(DESIGN_SYSTEM.{name}.variants).sort()")
        lines.append("}")
        lines.append("")

    # Image fit resolver
    lines.append(
        "export function resolveImageFit(fit: string | undefined | null): string {"
    )
    lines.append("  if (!fit) return DESIGN_SYSTEM.Image.defaultFit")
    lines.append("  const aliased = IMAGE_FIT_ALIASES[fit]")
    lines.append("  if (aliased) return aliased")
    lines.append(
        "  if ((DESIGN_SYSTEM.Image.fitModes as readonly string[]).includes(fit)) return fit"
    )
    lines.append("  return DESIGN_SYSTEM.Image.defaultFit")
    lines.append("}")
    lines.append("")

    # Treatment resolvers — author intent → (kind, accent) per component.
    lines.extend(emit_treatment_resolvers_ts(catalog))

    # Layout resolver — appended at the bottom of design-system.ts
    lines.extend(emit_layout_ts(catalog["layout"]))

    return "\n".join(lines)


def _intent_axes(comp: dict[str, Any]) -> list[str]:
    """Ordered list of intent axis names this component accepts.

    Derived from the union of keys across all `match` entries in
    `treatments` (plus the `defaults` map). Excludes any axis that never
    appears in a match (avoids generating unused params).
    """
    intents = comp.get("intents", {})
    defaults = intents.get("defaults", {})
    axes: set[str] = set(defaults.keys())
    for t in comp.get("treatments", []):
        match = t.get("match") or {}
        axes.update(match.keys())
    return sorted(axes)


def emit_treatment_resolvers_ts(catalog: dict[str, Any]) -> list[str]:
    """Emit `resolve<Component>Treatment(...)` per intent-driven component.

    Signature for a component with axes [emphasis, tone]:
        resolveButtonTreatment(emphasis?: string, tone?: string): VariantSpec

    Returns the (kind, accent) VariantSpec selected by the first matching
    rule in the catalog's treatments list. Unset axes fall back to defaults
    declared in `intents.defaults`. Unknown axis values fall through the
    chain to the catch-all default.
    """
    lines: list[str] = [
        "// ---------------------------------------------------------------------------",
        "// Treatment resolvers — author intent → renderer (kind, accent) pair.",
        "// Each component's treatments table is the single source of truth;",
        "// authoring helpers + renderers consume these resolvers so the mapping",
        "// stays catalog-driven.",
        "// ---------------------------------------------------------------------------",
        "",
    ]
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        if "treatments" not in comp:
            continue
        axes = _intent_axes(comp)
        # An axis is "used" if at least one treatment's match clause references
        # it. Skip generating fallback locals for unused axes — they'd just be
        # dead `_size` bindings that fail `noUnusedLocals`.
        used_axes: set[str] = set()
        for t in comp.get("treatments", []):
            used_axes.update((t.get("match") or {}).keys())
        intents = comp.get("intents", {})
        defaults = intents.get("defaults", {})
        # Function signature includes all author-visible axes (even unused
        # ones — e.g., `size` on Fab, kept for API symmetry).
        params = ", ".join(f"{ax}?: string" for ax in axes)
        lines.append(
            f"export function resolve{name}Treatment({params}): VariantSpec {{"
        )
        # Suppress unused-parameter warnings for axes the treatments table
        # doesn't actually consult.
        unused = [ax for ax in axes if ax not in used_axes]
        if unused:
            ignore = ", ".join(f"void {ax}" for ax in unused)
            lines.append(f"  {ignore};  // axis present in API but no rule consults it")
        # Default resolution for each USED axis
        for ax in sorted(used_axes):
            dflt = defaults.get(ax)
            if dflt is not None:
                lines.append(f"  const _{ax} = {ax} ?? {json_str(dflt)}")
            else:
                lines.append(f"  const _{ax} = {ax}")
        # Match chain — first match wins
        for t in comp["treatments"]:
            match = t.get("match") or {}
            spec_literal = (
                f"{{ kind: {json_str(t['kind'])}, accent: {json_str(t['accent'])} }}"
            )
            if not match:
                lines.append(f"  return {spec_literal}")
                continue
            conds = " && ".join(
                f"_{k} === {json_str(v)}" for k, v in sorted(match.items())
            )
            lines.append(f"  if ({conds}) return {spec_literal}")
        lines.append("}")
        lines.append("")
        # Selected-overlay (Chip only)
        sel = comp.get("selected_treatment")
        if sel:
            lines.append(
                f"export const {name.upper()}_SELECTED_TREATMENT: VariantSpec = "
                f"{{ kind: {json_str(sel['kind'])}, accent: {json_str(sel['accent'])} }}"
            )
            lines.append("")
    return lines


def emit_layout_ts(layout: dict[str, Any]) -> list[str]:
    lines: list[str] = [
        "// ---------------------------------------------------------------------------",
        "// Layout-default resolution — see shared/protocol/spec.md rule 10.",
        "// Pure function over enums; identical contract across TS / Kotlin / C.",
        "// ---------------------------------------------------------------------------",
        "",
        'export type LayoutSizeResult = "fill" | "wrap" | "fixed" | "grow"',
        "",
        "interface LayoutContainerPlain {",
        "  readonly child_default_width: string",
        "  readonly child_default_height: string",
        "  // Gap between consecutive children, keyed by child component variant.",
        '  // Values are spacing-token names (e.g. "s", "none") resolved by each',
        "  // renderer at runtime against its own size-class-resolved token table.",
        '  // `"none"` is the sentinel for literal 0. Look up via resolveListChildGap.',
        "  readonly child_gaps?: Readonly<Record<string, string>>",
        "}",
        "interface LayoutSlotPolicy {",
        "  readonly width: string",
        "  readonly height: string",
        "}",
        "interface LayoutContainerSlotted {",
        "  readonly slot_policies: Readonly<Record<string, LayoutSlotPolicy>>",
        "}",
        "type LayoutContainer = LayoutContainerPlain | LayoutContainerSlotted",
        "interface LayoutComponentIntrinsic {",
        "  readonly width: string",
        "  readonly height: string",
        "}",
        "interface LayoutVariantOverride {",
        "  readonly width?: string",
        "  readonly height?: string",
        "}",
        "",
        "export const LAYOUT = {",
        "  containers: {",
    ]
    for cname, c in sorted_containers(layout):
        if "slot_policies" in c:
            lines.append(f"    {cname}: {{")
            lines.append("      slot_policies: {")
            for slot_key in sorted(c["slot_policies"].keys()):
                slot = c["slot_policies"][slot_key]
                lines.append(
                    f"        {ts_key(slot_key)}: {{ width: {json_str(slot['width'])}, "
                    f"height: {json_str(slot['height'])} }},"
                )
            lines.append("      },")
            lines.append("    },")
        else:
            parts = [
                f"child_default_width: {json_str(c['child_default_width'])}",
                f"child_default_height: {json_str(c['child_default_height'])}",
            ]
            if "child_gaps" in c:
                gap_pairs = ", ".join(
                    f"{ts_key(k)}: {json_str(v)}"
                    for k, v in sorted(c["child_gaps"].items())
                )
                parts.append(f"child_gaps: {{ {gap_pairs} }}")
            lines.append(f"    {cname}: {{ {', '.join(parts)} }},")
    lines.append("  } as Readonly<Record<string, LayoutContainer>>,")
    lines.append("  components: {")
    for cname, c in sorted_layout_components(layout):
        lines.append(
            f"    {cname}: {{ width: {json_str(c['width'])}, "
            f"height: {json_str(c['height'])} }},"
        )
    lines.append("  } as Readonly<Record<string, LayoutComponentIntrinsic>>,")
    lines.append("  variant_overrides: {")
    for cname, variants in sorted_variant_overrides(layout):
        lines.append(f"    {cname}: {{")
        for vname in sorted(variants.keys()):
            v = variants[vname]
            parts = []
            if "width" in v:
                parts.append(f"width: {json_str(v['width'])}")
            if "height" in v:
                parts.append(f"height: {json_str(v['height'])}")
            lines.append(f"      {ts_key(vname)}: {{ {', '.join(parts)} }},")
        lines.append("    },")
    lines.append(
        "  } as Readonly<Record<string, Readonly<Record<string, LayoutVariantOverride>>>>,"
    )
    lines.append("} as const")
    lines.append("")

    # Resolver helpers + public API
    lines.extend(
        [
            "function stretchToResult(policy: string): LayoutSizeResult {",
            '  return policy === "cross_axis_fill" ? "fill" : "wrap"',
            "}",
            "",
            "function resolveContainerPolicy(",
            "  parentKind: string,",
            "  slotIndex: number,",
            "  slotName: string | null,",
            '  axis: "width" | "height",',
            "): string | null {",
            "  const c = LAYOUT.containers[parentKind]",
            "  if (!c) return null",
            '  if ("child_default_width" in c) {',
            '    return axis === "width" ? c.child_default_width : c.child_default_height',
            "  }",
            "  let key: string | null",
            '  if (parentKind === "Box") {',
            '    key = slotIndex === 0 ? "background" : "overlay"',
            '  } else if (parentKind === "Scaffold") {',
            "    key = slotName",
            "  } else {",
            "    key = null",
            "  }",
            "  if (key === null) return null",
            "  const slot = c.slot_policies[key]",
            "  if (!slot) return null",
            '  return axis === "width" ? slot.width : slot.height',
            "}",
            "",
            "function effectiveIntrinsic(",
            "  childKind: string,",
            "  childVariant: string | null,",
            '  axis: "width" | "height",',
            "): string {",
            "  if (childVariant) {",
            "    const o = LAYOUT.variant_overrides[childKind]?.[childVariant]",
            '    const v = o && (axis === "width" ? o.width : o.height)',
            "    if (v) return v",
            "  }",
            '  return LAYOUT.components[childKind]?.[axis] ?? "wrap"',
            "}",
            "",
            "function resolveAxis(",
            "  parentKind: string | null,",
            "  slotIndex: number,",
            "  slotName: string | null,",
            "  childKind: string,",
            "  childVariant: string | null,",
            "  ownKeyword: string | null,",
            '  axis: "width" | "height",',
            "): LayoutSizeResult {",
            "  // Step 1: explicit own keyword wins over catalog defaults.",
            '  if (ownKeyword === "fill") return "fill"',
            '  if (ownKeyword === "wrap") return "wrap"',
            '  if (ownKeyword === "grow") return "grow"',
            "  // Step 2: component intrinsic decides on its own when possible.",
            "  // 'wrap' / 'fixed' return immediately. Only 'parent' (the explicit",
            "  // 'I follow my parent' marker) consults the parent slot policy.",
            "  // This is what makes Button + Chip wrap content even in a Column",
            "  // whose other children (Card, TextField, ...) fill cross-axis.",
            "  const intrinsic = effectiveIntrinsic(childKind, childVariant, axis)",
            '  if (intrinsic === "wrap") return "wrap"',
            '  if (intrinsic === "fixed") return "fixed"',
            "  // intrinsic === 'parent' — consult parent's container policy.",
            "  if (parentKind) {",
            "    const policy = resolveContainerPolicy(parentKind, slotIndex, slotName, axis)",
            "    if (policy !== null) return stretchToResult(policy)",
            "  }",
            "  // Root or unknown parent — best-effort FILL for 'parent'.",
            '  return "fill"',
            "}",
            "",
            "export function resolveChildWidth(",
            "  parentKind: string | null,",
            "  slotIndex: number,",
            "  slotName: string | null,",
            "  childKind: string,",
            "  childVariant: string | null,",
            "  ownKeyword: string | null,",
            "): LayoutSizeResult {",
            '  return resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, "width")',
            "}",
            "",
            "export function resolveChildHeight(",
            "  parentKind: string | null,",
            "  slotIndex: number,",
            "  slotName: string | null,",
            "  childKind: string,",
            "  childVariant: string | null,",
            "  ownKeyword: string | null,",
            "): LayoutSizeResult {",
            '  return resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, "height")',
            "}",
            "",
            "// Look up the gap a container should apply between consecutive children",
            '// of a given variant. Returns a spacing-token name (e.g. "s") or',
            '// "none" (sentinel for 0). Returns null if the container has no',
            "// child_gaps policy. Callers map the token name to their renderer's",
            "// native unit via shared/tokens/{compact,expanded}.yaml.",
            "export function resolveContainerChildGap(",
            "  parentKind: string,",
            "  childKind: string,",
            "): string | null {",
            "  const c = LAYOUT.containers[parentKind]",
            '  if (!c || !("child_gaps" in c) || !c.child_gaps) return null',
            '  return c.child_gaps[childKind] ?? c.child_gaps["default"] ?? null',
            "}",
            "",
        ]
    )
    # COMPACT_HINTS emission — author-time hints consumed by the TS-side
    # compact-discipline guards (server/src/server/agent/define-face.ts) and
    # future pattern-lint. Non-TS renderers do not consume this surface yet.
    lines.extend(emit_compact_hints_ts(layout))
    return lines


def emit_compact_hints_ts(layout: dict[str, Any]) -> list[str]:
    """Emit COMPACT_HINTS dict + typed accessor helpers.

    Shape:
        export const COMPACT_HINTS = {
          Progress: { max_circular_size_dp: 100 },
          Row: { orientation_hint: "collapse_to_column", max_selected_chips: 2 },
          ...
        } as const

    Empty if no component has a `compact:` block.
    """
    lines: list[str] = []
    rows: list[tuple[str, dict[str, Any]]] = []
    for cname, comp in sorted_layout_components(layout):
        compact = comp.get("compact")
        if isinstance(compact, dict) and compact:
            rows.append((cname, compact))
    lines.append(
        "// ---------------------------------------------------------------------------"
    )
    lines.append(
        "// Compact-class authoring hints — consumed by TS-side compact-discipline"
    )
    lines.append(
        "// guards (server/src/server/agent/define-face.ts). Non-TS renderers do not"
    )
    lines.append(
        "// read this surface today; the source of truth for compact behavior on"
    )
    lines.append(
        "// Wear / ESP32 / web-narrow lives in each renderer's translation layer."
    )
    lines.append(
        "// ---------------------------------------------------------------------------"
    )
    lines.append("")
    lines.append("export interface CompactHints {")
    lines.append("  readonly max_circular_size_dp?: number")
    lines.append("  readonly orientation_hint?: string")
    lines.append("  readonly max_selected_chips?: number")
    lines.append("  readonly max_body_children?: number")
    lines.append("}")
    lines.append("")
    lines.append(
        "export const COMPACT_HINTS: Readonly<Record<string, CompactHints>> = {"
    )
    for cname, hints in rows:
        parts: list[str] = []
        for key in sorted(hints.keys()):
            val = hints[key]
            if isinstance(val, str):
                parts.append(f"{key}: {json_str(val)}")
            else:
                parts.append(f"{key}: {val}")
        lines.append(f"  {cname}: {{ {', '.join(parts)} }},")
    lines.append("}")
    lines.append("")
    return lines


def json_str(s: str) -> str:
    """JSON-encoded TS/JS string literal."""
    import json

    return json.dumps(s, ensure_ascii=False)


# Layout-resolution emitters — appended to each language output.
# The catalog's `layout` block is static; the resolver is a pure function over
# (parent_kind, slot_index, slot_name, child_kind, child_variant, own_keyword)
# → 'fill' | 'wrap' | 'fixed' | 'grow'. FIXED means the renderer reads dp from own_modifier.width.


def sorted_containers(layout: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return sorted(layout["containers"].items(), key=lambda kv: kv[0])


def sorted_layout_components(
    layout: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    return sorted(layout["components"].items(), key=lambda kv: kv[0])


def sorted_variant_overrides(
    layout: dict[str, Any],
) -> list[tuple[str, dict[str, dict[str, str]]]]:
    """Collect per-component variant_overrides into a flat (component → variants)
    list. Source: layout.components.<Name>.variant_overrides (nested).
    """
    out: list[tuple[str, dict[str, dict[str, str]]]] = []
    for cname, comp in (layout.get("components") or {}).items():
        if not isinstance(comp, dict):
            continue
        vo = comp.get("variant_overrides")
        if vo:
            out.append((cname, vo))
    return sorted(out, key=lambda kv: kv[0])


def ts_key(name: str) -> str:
    """Quote a TS object key only when it isn't a bare identifier."""
    import re

    if re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$", name):
        return name
    return json_str(name)


# Kotlin output


def emit_kotlin(catalog: dict[str, Any]) -> str:
    lines: list[str] = [
        f"// {HEADER}",
        "// Source: shared/protocol/design-system/design-system.yaml",
        "",
        "package com.moumantai.protocol.designsystem",
        "",
        "data class VariantSpec(val kind: String, val accent: String)",
        "",
        "data class ComponentSpec(",
        "    val defaultVariant: String,",
        "    val variants: Map<String, VariantSpec>,",
        ") {",
        "    fun resolve(variant: String?): VariantSpec {",
        "        val key = variant ?: defaultVariant",
        "        return variants[key] ?: variants.getValue(defaultVariant)",
        "    }",
        "}",
        "",
        "data class ImageSpec(",
        "    val defaultFit: String,",
        "    val fitModes: List<String>,",
        "    val fitAliases: Map<String, String>,",
        ") {",
        "    fun resolve(fit: String?): String {",
        "        if (fit == null) return defaultFit",
        "        fitAliases[fit]?.let { return it }",
        "        if (fit in fitModes) return fit",
        "        return defaultFit",
        "    }",
        "}",
        "",
        "data class AlignmentsSpec(val default: String, val values: List<String>)",
        "",
        "data class ArrangementsSpec(val default: String, val values: List<String>)",
        "",
        "object DesignSystem {",
    ]

    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        lines.append(f"    val {name} = ComponentSpec(")
        lines.append(f"        defaultVariant = {kt_str(comp['default_variant'])},")
        lines.append("        variants = mapOf(")
        for vname, v in sorted_variants(comp):
            lines.append(
                f"            {kt_str(vname)} to VariantSpec("
                f"kind = {kt_str(v['kind'])}, accent = {kt_str(v['accent'])}),"
            )
        lines.append("        ),")
        lines.append("    )")
        lines.append("")

    img = catalog["components"]["Image"]
    lines.append("    val Image = ImageSpec(")
    lines.append(f"        defaultFit = {kt_str(img['default_fit'])},")
    fit_modes_str = ", ".join(kt_str(m) for m in sorted(img["fit_modes"]))
    lines.append(f"        fitModes = listOf({fit_modes_str}),")
    lines.append("        fitAliases = mapOf(")
    for alias in sorted(img["fit_aliases"].keys()):
        lines.append(
            f"            {kt_str(alias)} to {kt_str(img['fit_aliases'][alias])},"
        )
    lines.append("        ),")
    lines.append("    )")
    lines.append("")

    al = catalog["alignments"]
    lines.append("    val Alignments = AlignmentsSpec(")
    lines.append(f"        default = {kt_str(al['default'])},")
    al_values_str = ", ".join(kt_str(v) for v in sorted(al["values"]))
    lines.append(f"        values = listOf({al_values_str}),")
    lines.append("    )")

    arr = catalog.get("arrangements")
    if arr:
        lines.append("    val Arrangements = ArrangementsSpec(")
        lines.append(f"        default = {kt_str(arr['default'])},")
        arr_values_str = ", ".join(kt_str(v) for v in arr["values"])
        lines.append(f"        values = listOf({arr_values_str}),")
        lines.append("    )")

    lines.append("}")
    lines.append("")

    # Treatment resolvers — author intent → (kind, accent) per component.
    lines.extend(emit_treatment_resolvers_kotlin(catalog))

    # Layout resolver — sibling object alongside DesignSystem.
    lines.extend(emit_layout_kotlin(catalog["layout"]))

    return "\n".join(lines)


def emit_treatment_resolvers_kotlin(catalog: dict[str, Any]) -> list[str]:
    """Emit `resolve<Component>Treatment(...)` per intent-driven component
    in Kotlin. Mirrors the TS shape so all 4 renderers consume identical
    catalog logic.
    """
    lines: list[str] = [
        "// ---------------------------------------------------------------------------",
        "// Treatment resolvers — author intent → renderer (kind, accent) pair.",
        "// Mirrors the TS resolve<X>Treatment functions; the catalog's treatments",
        "// table is the single source of truth for all renderers.",
        "// ---------------------------------------------------------------------------",
        "",
        "object DesignSystemTreatments {",
    ]
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        if "treatments" not in comp:
            continue
        axes = _intent_axes(comp)
        used_axes: set[str] = set()
        for t in comp.get("treatments", []):
            used_axes.update((t.get("match") or {}).keys())
        intents = comp.get("intents", {})
        defaults = intents.get("defaults", {})
        params = ", ".join(f"{ax}: String? = null" for ax in axes)
        lines.append(f"    fun resolve{name}({params}): VariantSpec {{")
        # Suppress unused warnings for axes the table doesn't reference.
        for ax in axes:
            if ax not in used_axes:
                lines.append(
                    f'        @Suppress("UNUSED_PARAMETER") val _unused_{ax} = {ax}'
                )
        for ax in sorted(used_axes):
            dflt = defaults.get(ax)
            if dflt is not None:
                lines.append(f"        val _{ax} = {ax} ?: {kt_str(dflt)}")
            else:
                lines.append(f"        val _{ax} = {ax}")
        for t in comp["treatments"]:
            match = t.get("match") or {}
            spec_literal = (
                f"VariantSpec(kind = {kt_str(t['kind'])}, "
                f"accent = {kt_str(t['accent'])})"
            )
            if not match:
                lines.append(f"        return {spec_literal}")
                continue
            conds = " && ".join(
                f"_{k} == {kt_str(v)}" for k, v in sorted(match.items())
            )
            lines.append(f"        if ({conds}) return {spec_literal}")
        lines.append("    }")
        lines.append("")
        # Selected-overlay constant (Chip)
        sel = comp.get("selected_treatment")
        if sel:
            lines.append(
                f"    val {name.upper()}_SELECTED_TREATMENT: VariantSpec = "
                f"VariantSpec(kind = {kt_str(sel['kind'])}, "
                f"accent = {kt_str(sel['accent'])})"
            )
            lines.append("")
    lines.append("}")
    lines.append("")
    return lines


def emit_layout_kotlin(layout: dict[str, Any]) -> list[str]:
    lines: list[str] = [
        "// ---------------------------------------------------------------------------",
        "// Layout-default resolution — see shared/protocol/spec.md rule 10.",
        "// Pure function over enums; identical contract across TS / Kotlin / C.",
        "// ---------------------------------------------------------------------------",
        "",
        "enum class LayoutSizeResult { FILL, WRAP, FIXED, GROW }",
        "",
        "object Layout {",
        "    private data class SlotPolicy(",
        "        val width: String,",
        "        val height: String,",
        "    )",
        "    private sealed interface Container {",
        "        data class Plain(",
        "            val crossWidth: String,",
        "            val crossHeight: String,",
        "            // Gap between consecutive children, keyed by child component",
        '            // variant. Values are spacing-token names (e.g. "s", "none");',
        '            // "none" is the literal-0 sentinel. Renderer maps the name to',
        "            // dp via its LocalDimensions table. Empty = no policy.",
        "            val childGaps: Map<String, String> = emptyMap(),",
        "        ) : Container",
        "        data class Slotted(val slots: Map<String, SlotPolicy>) : Container",
        "    }",
        "    private data class IntrinsicSize(val width: String, val height: String)",
        "    private data class VariantOverride(val width: String? = null, val height: String? = null)",
        "",
        "    private val CONTAINERS: Map<String, Container> = mapOf(",
    ]
    for cname, c in sorted_containers(layout):
        if "slot_policies" in c:
            lines.append(f"        {kt_str(cname)} to Container.Slotted(mapOf(")
            for slot_key in sorted(c["slot_policies"].keys()):
                slot = c["slot_policies"][slot_key]
                lines.append(
                    f"            {kt_str(slot_key)} to SlotPolicy("
                    f"width = {kt_str(slot['width'])}, "
                    f"height = {kt_str(slot['height'])}),",
                )
            lines.append("        )),")
        else:
            args = [
                f"crossWidth = {kt_str(c['child_default_width'])}",
                f"crossHeight = {kt_str(c['child_default_height'])}",
            ]
            if "child_gaps" in c:
                gap_pairs = ", ".join(
                    f"{kt_str(k)} to {kt_str(v)}"
                    for k, v in sorted(c["child_gaps"].items())
                )
                args.append(f"childGaps = mapOf({gap_pairs})")
            lines.append(
                f"        {kt_str(cname)} to Container.Plain({', '.join(args)}),"
            )
    lines.append("    )")
    lines.append("")

    lines.append("    private val COMPONENTS: Map<String, IntrinsicSize> = mapOf(")
    for cname, c in sorted_layout_components(layout):
        lines.append(
            f"        {kt_str(cname)} to IntrinsicSize("
            f"width = {kt_str(c['width'])}, height = {kt_str(c['height'])}),"
        )
    lines.append("    )")
    lines.append("")

    lines.append(
        "    private val VARIANT_OVERRIDES: Map<String, Map<String, VariantOverride>> = mapOf("
    )
    for cname, variants in sorted_variant_overrides(layout):
        lines.append(f"        {kt_str(cname)} to mapOf(")
        for vname in sorted(variants.keys()):
            v = variants[vname]
            parts = []
            if "width" in v:
                parts.append(f"width = {kt_str(v['width'])}")
            if "height" in v:
                parts.append(f"height = {kt_str(v['height'])}")
            lines.append(
                f"            {kt_str(vname)} to VariantOverride({', '.join(parts)}),"
            )
        lines.append("        ),")
    lines.append("    )")
    lines.append("")

    lines.extend(
        [
            "    fun resolveChildWidth(",
            "        parentKind: String?,",
            "        slotIndex: Int,",
            "        slotName: String?,",
            "        childKind: String,",
            "        childVariant: String?,",
            "        ownKeyword: String?,",
            "    ): LayoutSizeResult = resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, isWidth = true)",
            "",
            "    fun resolveChildHeight(",
            "        parentKind: String?,",
            "        slotIndex: Int,",
            "        slotName: String?,",
            "        childKind: String,",
            "        childVariant: String?,",
            "        ownKeyword: String?,",
            "    ): LayoutSizeResult = resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, isWidth = false)",
            "",
            "    private fun effectiveIntrinsic(",
            "        childKind: String,",
            "        childVariant: String?,",
            "        isWidth: Boolean,",
            "    ): String {",
            "        if (childVariant != null) {",
            "            val o = VARIANT_OVERRIDES[childKind]?.get(childVariant)",
            "            val v = if (o == null) null else if (isWidth) o.width else o.height",
            "            if (v != null) return v",
            "        }",
            '        return COMPONENTS[childKind]?.let { if (isWidth) it.width else it.height } ?: "wrap"',
            "    }",
            "",
            "    private fun resolveAxis(",
            "        parentKind: String?,",
            "        slotIndex: Int,",
            "        slotName: String?,",
            "        childKind: String,",
            "        childVariant: String?,",
            "        ownKeyword: String?,",
            "        isWidth: Boolean,",
            "    ): LayoutSizeResult {",
            "        // Step 1: explicit keyword wins over catalog defaults.",
            '        if (ownKeyword == "fill") return LayoutSizeResult.FILL',
            '        if (ownKeyword == "wrap") return LayoutSizeResult.WRAP',
            '        if (ownKeyword == "grow") return LayoutSizeResult.GROW',
            "        // Step 2: component intrinsic decides on its own when possible.",
            "        // 'wrap' / 'fixed' return immediately. Only 'parent' (the explicit",
            "        // 'I follow my parent' marker) consults the parent slot policy.",
            "        // This is what makes Button + Chip wrap content even in a Column",
            "        // whose other children (Card, TextField, ...) fill cross-axis.",
            "        val intrinsic = effectiveIntrinsic(childKind, childVariant, isWidth)",
            '        if (intrinsic == "wrap") return LayoutSizeResult.WRAP',
            '        if (intrinsic == "fixed") return LayoutSizeResult.FIXED',
            '        // intrinsic == "parent" — consult parent\'s container policy.',
            "        if (parentKind != null) {",
            "            val policy = resolveContainerPolicy(parentKind, slotIndex, slotName, isWidth)",
            "            if (policy != null) return stretchToResult(policy)",
            "        }",
            "        // Root or unknown parent — best-effort FILL for 'parent'.",
            "        return LayoutSizeResult.FILL",
            "    }",
            "",
            "    private fun resolveContainerPolicy(",
            "        parentKind: String,",
            "        slotIndex: Int,",
            "        slotName: String?,",
            "        isWidth: Boolean,",
            "    ): String? {",
            "        val c = CONTAINERS[parentKind] ?: return null",
            "        return when (c) {",
            "            is Container.Plain -> if (isWidth) c.crossWidth else c.crossHeight",
            "            is Container.Slotted -> {",
            "                val key = when (parentKind) {",
            '                    "Box" -> if (slotIndex == 0) "background" else "overlay"',
            '                    "Scaffold" -> slotName',
            "                    else -> null",
            "                } ?: return null",
            "                val slot = c.slots[key] ?: return null",
            "                if (isWidth) slot.width else slot.height",
            "            }",
            "        }",
            "    }",
            "",
            "    private fun stretchToResult(policy: String): LayoutSizeResult =",
            '        if (policy == "cross_axis_fill") LayoutSizeResult.FILL else LayoutSizeResult.WRAP',
            "",
            "    // Look up the gap a container should apply between consecutive children",
            '    // of a given variant. Returns a spacing-token name (e.g. "s") or',
            '    // "none" (literal-0 sentinel). null = container has no child_gaps',
            "    // policy. Callers map the name to dp via LocalDimensions.",
            "    fun containerChildGap(parentKind: String, childKind: String): String? {",
            "        val c = CONTAINERS[parentKind] as? Container.Plain ?: return null",
            "        if (c.childGaps.isEmpty()) return null",
            '        return c.childGaps[childKind] ?: c.childGaps["default"]',
            "    }",
            "}",
            "",
        ]
    )
    return lines


def kt_str(s: str) -> str:
    # JSON quoting works for our YAML strings (ASCII identifiers + simple words).
    return json_str(s)


# C header output


def emit_c_header(catalog: dict[str, Any]) -> str:
    lines: list[str] = [
        f"// {HEADER}",
        "// Source: shared/protocol/design-system/design-system.yaml",
        "",
        "#ifndef MOUMANTAI_DESIGN_SYSTEM_H",
        "#define MOUMANTAI_DESIGN_SYSTEM_H",
        "",
        "#ifdef __cplusplus",
        'extern "C" {',
        "#endif",
        "",
        "// Semantic kinds — every renderer translates these to native primitives.",
        "typedef enum {",
        "    DS_KIND_UNKNOWN = 0,",
    ]
    kinds = sorted(
        {
            v["kind"]
            for comp in catalog["components"].values()
            if isinstance(comp, dict) and "variants" in comp
            for v in comp["variants"].values()
        }
    )
    for k in kinds:
        lines.append(f"    DS_KIND_{k.upper()},")
    lines.append("} ds_kind_t;")
    lines.append("")

    lines.append("// Accent token namespaces — map onto theme color roles.")
    accents = sorted(
        {
            v["accent"]
            for comp in catalog["components"].values()
            if isinstance(comp, dict) and "variants" in comp
            for v in comp["variants"].values()
        }
    )
    lines.append("typedef enum {")
    lines.append("    DS_ACCENT_UNKNOWN = 0,")
    for a in accents:
        lines.append(f"    DS_ACCENT_{a.upper()},")
    lines.append("} ds_accent_t;")
    lines.append("")

    lines.append("typedef struct {")
    lines.append("    ds_kind_t kind;")
    lines.append("    ds_accent_t accent;")
    lines.append("} ds_variant_spec_t;")
    lines.append("")

    # Per-component variant enum + lookup function declaration
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        prefix = f"ds_{name.lower()}_variant"
        lines.append(f"typedef enum {{")
        lines.append(f"    {prefix.upper()}_UNKNOWN = 0,")
        for vname, _v in sorted_variants(comp):
            lines.append(f"    {prefix.upper()}_{c_ident(vname).upper()},")
        lines.append(f"}} {prefix}_t;")
        lines.append("")
        lines.append(f"// Default variant constant (string form matches the wire).")
        lines.append(f'#define {prefix.upper()}_DEFAULT "{comp["default_variant"]}"')
        lines.append("")
        lines.append(
            f"// Look up a variant string against the catalog. Returns the "
            f"default's spec if unknown."
        )
        lines.append(
            f"ds_variant_spec_t ds_{name.lower()}_resolve(const char* variant);"
        )
        lines.append("")

    # Image
    img = catalog["components"]["Image"]
    lines.append("// Image fit modes (canonical).")
    lines.append("typedef enum {")
    lines.append("    DS_IMAGE_FIT_UNKNOWN = 0,")
    for m in sorted(img["fit_modes"]):
        lines.append(f"    DS_IMAGE_FIT_{c_ident(m).upper()},")
    lines.append("} ds_image_fit_t;")
    lines.append("")
    lines.append(f'#define DS_IMAGE_FIT_DEFAULT "{img["default_fit"]}"')
    lines.append("")
    lines.append("// Resolve a fit string (canonical or alias) to a canonical mode.")
    lines.append(
        "// Returns DS_IMAGE_FIT_DEFAULT (string) if input is NULL or unknown."
    )
    lines.append("const char* ds_image_resolve_fit(const char* fit);")
    lines.append("")

    # Layout resolver — declared before the closing extern "C".
    lines.extend(emit_layout_c_header(catalog["layout"]))

    lines.append("#ifdef __cplusplus")
    lines.append("}")
    lines.append("#endif")
    lines.append("")
    lines.append("#endif  // MOUMANTAI_DESIGN_SYSTEM_H")
    lines.append("")
    return "\n".join(lines)


def emit_layout_c_header(layout: dict[str, Any]) -> list[str]:
    return [
        "// ---------------------------------------------------------------------------",
        "// Layout-default resolution — see shared/protocol/spec.md rule 10.",
        "// Pure function over enums; identical contract across TS / Kotlin / C.",
        "// ---------------------------------------------------------------------------",
        "",
        "typedef enum {",
        "    DS_LAYOUT_FILL = 0,",
        "    DS_LAYOUT_WRAP,",
        "    DS_LAYOUT_FIXED,",
        "    DS_LAYOUT_GROW,",
        "} ds_layout_size_t;",
        "",
        "// Resolve the cross-axis size policy for a child component.",
        "// Inputs:",
        '//   parent_kind   — TypeName of the parent ("Column", "Box", ...) or NULL for root',
        "//   slot_index    — 0-based index in parent's children list (used by Box)",
        '//   slot_name     — Scaffold slot identifier ("body" / "top_bar" / "fab") or NULL',
        '//   child_kind    — TypeName of the child ("Card", "TextField", ...)',
        '//   child_variant — variant string (e.g. "linear" for Progress) or NULL',
        '//   own_keyword   — explicit Modifier.width keyword ("fill" / "wrap" / "grow") or NULL',
        "// Returns: DS_LAYOUT_FILL / DS_LAYOUT_WRAP / DS_LAYOUT_FIXED / DS_LAYOUT_GROW.",
        "// On DS_LAYOUT_FIXED the renderer reads the explicit dp from the modifier.",
        "ds_layout_size_t ds_layout_resolve_width(",
        "    const char* parent_kind,",
        "    int slot_index,",
        "    const char* slot_name,",
        "    const char* child_kind,",
        "    const char* child_variant,",
        "    const char* own_keyword);",
        "",
        "ds_layout_size_t ds_layout_resolve_height(",
        "    const char* parent_kind,",
        "    int slot_index,",
        "    const char* slot_name,",
        "    const char* child_kind,",
        "    const char* child_variant,",
        "    const char* own_keyword);",
        "",
        "// Look up the gap a container should apply between consecutive children",
        '// of a given variant. Returns a spacing-token name ("s", "none", ...)',
        "// or NULL if the container has no child_gaps policy. Caller maps the",
        "// name to pixels via generated_tokens.h (e.g. MOUMANTAI_SPACING_S).",
        '// "none" is the sentinel for literal 0.',
        "const char* ds_container_child_gap(const char* parent_kind, const char* child_kind);",
        "",
    ]


def c_ident(s: str) -> str:
    """Make a YAML key safe as a C identifier (replace non-alnum with _)."""
    import re

    return re.sub(r"[^A-Za-z0-9_]", "_", s)


def emit_c_source(catalog: dict[str, Any]) -> str:
    # Resolvers are NOT `static` — they're paired with extern declarations in
    # design_system.h so renderer translation units can link against them.
    lines: list[str] = [
        f"// {HEADER}",
        "// Source: shared/protocol/design-system/design-system.yaml",
        "// Implementations of ds_*_resolve declared in design_system.h. Externally linked.",
        "",
        '#include "design_system.h"',
        "",
        "#include <string.h>",
        "",
    ]

    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        default_v = comp["default_variant"]
        default_spec = comp["variants"][default_v]
        default_kind = f"DS_KIND_{default_spec['kind'].upper()}"
        default_accent = f"DS_ACCENT_{default_spec['accent'].upper()}"
        lines.append(
            f"ds_variant_spec_t ds_{name.lower()}_resolve(const char* variant) {{"
        )
        lines.append(
            f"    if (variant == NULL) "
            f"return (ds_variant_spec_t){{ {default_kind}, {default_accent} }};"
        )
        for vname, v in sorted_variants(comp):
            if vname == default_v:
                continue  # default falls through
            kind = f"DS_KIND_{v['kind'].upper()}"
            accent = f"DS_ACCENT_{v['accent'].upper()}"
            lines.append(
                f'    if (strcmp(variant, "{vname}") == 0) '
                f"return (ds_variant_spec_t){{ {kind}, {accent} }};"
            )
        lines.append(
            f"    return (ds_variant_spec_t){{ {default_kind}, {default_accent} }};"
        )
        lines.append("}")
        lines.append("")

    # Image fit resolver — mirrors resolveImageFit (TS) / ImageSpec.resolve (Kt).
    img = catalog["components"]["Image"]
    default_fit = img["default_fit"]
    lines.append("const char* ds_image_resolve_fit(const char* fit) {")
    lines.append(f'    if (fit == NULL) return "{default_fit}";')
    for alias in sorted(img["fit_aliases"].keys()):
        canonical = img["fit_aliases"][alias]
        lines.append(f'    if (strcmp(fit, "{alias}") == 0) return "{canonical}";')
    for mode in sorted(img["fit_modes"]):
        lines.append(f'    if (strcmp(fit, "{mode}") == 0) return "{mode}";')
    lines.append(f'    return "{default_fit}";')
    lines.append("}")
    lines.append("")

    # Layout resolver — appended after image fit body.
    lines.extend(emit_layout_c_source(catalog["layout"]))

    return "\n".join(lines)


def emit_layout_c_source(layout: dict[str, Any]) -> list[str]:
    """Emit layout resolver: one internal function with an axis flag + two public wrappers.
    If-else chains over component/slot strings; sorted alphabetically for byte-stable output."""
    lines: list[str] = [
        "// ---------------------------------------------------------------------------",
        "// Layout-default resolution — see shared/protocol/spec.md rule 10.",
        "// ---------------------------------------------------------------------------",
        "",
        "// Internal stretch-policy enum (intermediate value before mapping to ds_layout_size_t).",
        "// Negative return = no policy known (caller falls through to next step).",
        "static int ds_layout_container_policy(",
        "    const char* parent_kind,",
        "    int slot_index,",
        "    const char* slot_name,",
        "    int is_width) {",
        "    if (parent_kind == NULL) return -1;",
    ]

    # Two policy values (encoded as small ints to keep the C clean):
    #   0 = cross_axis_fill, 1 = cross_axis_wrap, 2 = none
    POLICY_INT = {"cross_axis_fill": 0, "cross_axis_wrap": 1, "none": 2}

    for cname, c in sorted_containers(layout):
        if "slot_policies" in c:
            lines.append(f'    if (strcmp(parent_kind, "{cname}") == 0) {{')
            if cname == "Box":
                # Indexed: slot 0 -> background, else overlay
                slots = c["slot_policies"]
                bg = slots["background"]
                ov = slots["overlay"]
                lines.append("        if (slot_index == 0) {")
                lines.append(
                    f"            return is_width ? {POLICY_INT[bg['width']]} : {POLICY_INT[bg['height']]};"
                )
                lines.append("        }")
                lines.append(
                    f"        return is_width ? {POLICY_INT[ov['width']]} : {POLICY_INT[ov['height']]};"
                )
            elif cname == "Scaffold":
                lines.append("        if (slot_name == NULL) return -1;")
                for slot_key in sorted(c["slot_policies"].keys()):
                    slot = c["slot_policies"][slot_key]
                    lines.append(
                        f'        if (strcmp(slot_name, "{slot_key}") == 0) '
                        f"return is_width ? {POLICY_INT[slot['width']]} : "
                        f"{POLICY_INT[slot['height']]};"
                    )
                lines.append("        return -1;")
            else:
                # Unknown slotted container — emit a defensive fallback.
                lines.append("        return -1;")
            lines.append("    }")
        else:
            lines.append(
                f'    if (strcmp(parent_kind, "{cname}") == 0) '
                f"return is_width ? {POLICY_INT[c['child_default_width']]} : "
                f"{POLICY_INT[c['child_default_height']]};"
            )
    lines.append("    return -1;")
    lines.append("}")
    lines.append("")

    # Per-component intrinsic.
    # Encoded as ints: 0 = parent (fill), 1 = wrap, 2 = fixed
    INTRINSIC_INT = {"parent": 0, "wrap": 1, "fixed": 2}
    lines.append("// Per-component intrinsic size; returns 0=parent, 1=wrap, 2=fixed.")
    lines.append(
        "static int ds_layout_intrinsic(const char* child_kind, int is_width) {"
    )
    lines.append("    if (child_kind == NULL) return 1;  // unknown -> wrap")
    for cname, c in sorted_layout_components(layout):
        lines.append(
            f'    if (strcmp(child_kind, "{cname}") == 0) '
            f"return is_width ? {INTRINSIC_INT[c['width']]} : {INTRINSIC_INT[c['height']]};"
        )
    lines.append("    return 1;")
    lines.append("}")
    lines.append("")

    # Variant overrides. Returns -1 if no override; otherwise an INTRINSIC_INT.
    lines.append("// Variant override; returns -1 if no override applies.")
    lines.append(
        "static int ds_layout_variant_override(const char* child_kind, "
        "const char* child_variant, int is_width) {"
    )
    lines.append("    if (child_kind == NULL || child_variant == NULL) return -1;")
    overrides = sorted_variant_overrides(layout)
    for cname, variants in overrides:
        lines.append(f'    if (strcmp(child_kind, "{cname}") == 0) {{')
        for vname in sorted(variants.keys()):
            v = variants[vname]
            w = INTRINSIC_INT[v["width"]] if "width" in v else -1
            h = INTRINSIC_INT[v["height"]] if "height" in v else -1
            lines.append(
                f'        if (strcmp(child_variant, "{vname}") == 0) '
                f"return is_width ? {w} : {h};"
            )
        lines.append("        return -1;")
        lines.append("    }")
    lines.append("    return -1;")
    lines.append("}")
    lines.append("")

    # The single internal resolver + two public wrappers.
    lines.extend(
        [
            "static ds_layout_size_t ds_layout_resolve_axis(",
            "    const char* parent_kind, int slot_index, const char* slot_name,",
            "    const char* child_kind, const char* child_variant,",
            "    const char* own_keyword, int is_width) {",
            "    // Step 1: explicit own keyword wins.",
            "    if (own_keyword != NULL) {",
            '        if (strcmp(own_keyword, "fill") == 0) return DS_LAYOUT_FILL;',
            '        if (strcmp(own_keyword, "wrap") == 0) return DS_LAYOUT_WRAP;',
            '        if (strcmp(own_keyword, "grow") == 0) return DS_LAYOUT_GROW;',
            "        // unknown keyword -> fall through.",
            "    }",
            "    // Step 2: component intrinsic (with variant override applied).",
            "    // Effective intrinsic: variant override wins over base intrinsic.",
            "    int intrinsic = ds_layout_variant_override(child_kind, child_variant, is_width);",
            "    if (intrinsic < 0) intrinsic = ds_layout_intrinsic(child_kind, is_width);",
            "    if (intrinsic == 1) return DS_LAYOUT_WRAP;",
            "    if (intrinsic == 2) return DS_LAYOUT_FIXED;",
            "    // intrinsic == 0 ('parent') — consult parent's container policy.",
            "    int policy = ds_layout_container_policy(parent_kind, slot_index, slot_name, is_width);",
            "    if (policy >= 0) {",
            "        return (policy == 0) ? DS_LAYOUT_FILL : DS_LAYOUT_WRAP;",
            "    }",
            "    // Root or unknown parent — best-effort FILL for 'parent'.",
            "    return DS_LAYOUT_FILL;",
            "}",
            "",
            "ds_layout_size_t ds_layout_resolve_width(",
            "    const char* parent_kind, int slot_index, const char* slot_name,",
            "    const char* child_kind, const char* child_variant, const char* own_keyword) {",
            "    return ds_layout_resolve_axis(parent_kind, slot_index, slot_name,",
            "        child_kind, child_variant, own_keyword, 1);",
            "}",
            "",
            "ds_layout_size_t ds_layout_resolve_height(",
            "    const char* parent_kind, int slot_index, const char* slot_name,",
            "    const char* child_kind, const char* child_variant, const char* own_keyword) {",
            "    return ds_layout_resolve_axis(parent_kind, slot_index, slot_name,",
            "        child_kind, child_variant, own_keyword, 0);",
            "}",
            "",
        ]
    )

    # Emit ds_container_child_gap — nested if-chains keyed by parent then child.
    lines.extend(
        [
            "// Container child-gap lookup. See header for contract.",
            "const char* ds_container_child_gap(const char* parent_kind, const char* child_kind) {",
            "    if (parent_kind == NULL) return NULL;",
            '    if (child_kind == NULL) child_kind = "default";',
        ]
    )
    any_emitted = False
    for cname, c in sorted_containers(layout):
        gaps = c.get("child_gaps")
        if not gaps:
            continue
        any_emitted = True
        lines.append(f'    if (strcmp(parent_kind, "{cname}") == 0) {{')
        # Specific kinds first, default last.
        for k in sorted(k for k in gaps.keys() if k != "default"):
            lines.append(
                f'        if (strcmp(child_kind, "{k}") == 0) return "{gaps[k]}";'
            )
        if "default" in gaps:
            lines.append(f'        return "{gaps["default"]}";')
        else:
            lines.append("        return NULL;")
        lines.append("    }")
    if not any_emitted:
        # Suppress unused-parameter warnings if no container has child_gaps yet.
        lines.append("    (void)child_kind;")
    lines.append("    return NULL;")
    lines.append("}")
    lines.append("")

    return lines


# CSS output


def emit_css(catalog: dict[str, Any]) -> str:
    lines: list[str] = [
        f"/* {HEADER}",
        "   Source: shared/protocol/design-system/design-system.yaml",
        "   Tokens are emitted by scripts/generate-tokens.py into each client. */",
        "",
    ]

    # Stable property order so output is byte-identical across runs.
    PROP_ORDER = ("background", "color", "border", "box-shadow")
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        lines.append(f"/* --- {name} variants --- */")
        for vname, v in sorted_variants(comp):
            decls = css_rules_for(v["kind"], v["accent"])
            class_name = f".moumantai-{name.lower()}--{vname}"
            lines.append(f"{class_name} {{")
            for prop in PROP_ORDER:
                if prop in decls:
                    lines.append(f"  {prop}: {decls[prop]};")
            lines.append("}")
            lines.append("")

    lines.extend(emit_layout_css(catalog["layout"]))

    return "\n".join(lines)


def emit_layout_css(_layout: dict[str, Any]) -> list[str]:
    """CSS explicit overrides via `data-parent-stretch` for non-flex contexts
    (e.g. Box overlay slots) and to opt out of parent stretching with `wrap`."""
    return [
        "/* --- Layout resolver hooks (data-parent-stretch) --- */",
        '[data-parent-stretch="cross_axis_fill"] {',
        "  width: 100%;",
        "}",
        '[data-parent-stretch="cross_axis_wrap"] {',
        "  width: auto;",
        "}",
        '[data-parent-stretch="none"] {',
        "  width: auto;",
        "}",
        "",
        "/* grow keyword: main-axis flex weight (flex: 1). */",
        "[data-grow] {",
        "  flex: 1;",
        "}",
        "",
    ]


# SDK types output — typed TS unions for the server SDK

DESIGN_SYSTEM_DIR = ROOT / "shared" / "protocol" / "design-system"


def emit_sdk_types(catalog: dict[str, Any]) -> str:
    """Emit shared/protocol/design-system/generated/sdk-types.ts."""
    lines: list[str] = [
        f"// {HEADER}",
        "// Source: shared/protocol/design-system/design-system.yaml",
        "",
        "// Typed unions consumed by the Moumantai server SDK so face-authoring TS gets",
        "// IDE/build errors on typos. The wire format stays free-form `string` (per",
        "// shared/protocol/spec.md rule 7) so LLMs that bypass the typed SDK still",
        '// work; renderers fall back to "omitted" semantics on unknown values.',
        "",
    ]

    # Layout sizing — from layout.size_keywords
    layout = catalog["layout"]
    keywords = sorted(layout.get("size_keywords", []))
    kw_union = " | ".join(json_str(k) for k in keywords)
    lines.append("// Layout sizing — derived from layout.size_keywords in catalog.")
    lines.append(f"export type SizeKeyword = {kw_union}")
    lines.append("export type SizeValue = SizeKeyword | number")
    lines.append("")

    # Alignment — from top-level alignments.values
    al = catalog["alignments"]
    al_values = sorted(al["values"])
    # Format with line breaks for readability (3 per row)
    lines.append(
        "// 9-value alignment grid — derived from top-level `alignments.values`."
    )
    lines.append("export type Alignment =")
    for i in range(0, len(al_values), 3):
        row_vals = al_values[i : i + 3]
        prefix = "  | " if i == 0 else "  | "
        lines.append(prefix + " | ".join(json_str(v) for v in row_vals))
    lines.append("")

    # Arrangement — from top-level arrangements.values
    arr = catalog.get("arrangements", {})
    arr_values = arr.get("values", [])
    # Keep insertion order for semantic grouping but sort for stability
    arr_sorted = sorted(arr_values)
    lines.append(
        "// Container main-axis distribution — derived from top-level `arrangements.values`."
    )
    lines.append("export type Arrangement =")
    lines.append("  | " + " | ".join(json_str(v) for v in arr_sorted))
    lines.append("")

    # Per-component intent axis unions — derived from components.<X>.intents.
    # These are the typed values authors write at the SDK layer; the framework
    # maps them to a (kind, accent) treatment via resolve<X>Treatment(...).
    lines.append(
        "// Per-component intent axis unions — derived from components.<X>.intents."
    )
    lines.append("// Authors write these via the typed SDK; the framework maps them to")
    lines.append(
        "// a (kind, accent) treatment via the catalog's resolve<X>Treatment(...)."
    )
    for name, comp in sorted_components(catalog):
        if name == "Image":
            continue
        intents = comp.get("intents") if isinstance(comp, dict) else None
        if not isinstance(intents, dict):
            continue
        for axis in sorted(intents):
            if axis == "defaults":
                continue
            if not axis.endswith("_values"):
                continue
            values = intents[axis]
            if not isinstance(values, list) or not values:
                continue
            type_name = f"{name}{axis[: -len('_values')].capitalize()}"
            union = " | ".join(json_str(v) for v in sorted(values))
            lines.append(f"export type {type_name} = {union}")
    lines.append("")

    # Image fit — from components.Image.fit_modes
    img = catalog["components"]["Image"]
    fit_modes = sorted(img["fit_modes"])
    fit_union = " | ".join(json_str(m) for m in fit_modes)
    lines.append("// Image fit — derived from components.Image.fit_modes.")
    lines.append(f"export type ImageFit = {fit_union}")
    lines.append("")

    return "\n".join(lines)


# authoring.md output — face author reference (generated)


def _intrinsic_summary(intrinsic_w: str, intrinsic_h: str) -> str:
    """Human-readable summary of a component's intrinsic sizing."""

    def label(k: str) -> str:
        if k == "parent":
            return "fill"
        if k == "wrap":
            return "content"
        if k == "fixed":
            return "fixed (renderer default)"
        return k

    w = label(intrinsic_w)
    h = label(intrinsic_h)
    if w == h:
        return f"content size (both axes)"
    return f"width: {w}, height: {h}"


def _parent_default(
    parent_kind: str,
    child_intrinsic_w: str,
    child_intrinsic_h: str,
    containers: dict[str, Any],
) -> str:
    """Return the effective default size description of a child in a given parent.

    This mimics the resolver algorithm narrative (step 2) for documentation.
    Only applies when child intrinsic is 'parent' on that axis.
    """

    def axis_result(axis: str, intrinsic: str) -> str:
        if intrinsic == "wrap":
            return "content"
        if intrinsic == "fixed":
            return "renderer default"
        # intrinsic == parent — consult container policy
        c = containers.get(parent_kind)
        if c is None:
            return "fill (best-effort)"
        if "slot_policies" in c:
            # For authoring.md we show the background slot (most common case)
            slot = c["slot_policies"].get("background") or c["slot_policies"].get(
                "body"
            )
            if slot is None:
                return "wrap"
            policy = slot[axis]
        else:
            policy = c.get(f"child_default_{axis}", "cross_axis_wrap")
        if policy == "cross_axis_fill":
            return "fill"
        if policy == "cross_axis_wrap":
            return "content"
        return "wrap"  # none -> wrap

    w = axis_result("width", child_intrinsic_w)
    h = axis_result("height", child_intrinsic_h)
    if w == h:
        if w == "fill":
            return "fills both axes"
        if w == "content":
            return "content size"
        return f"{w} (both axes)"
    return f"width: {w}, height: {h}"


def emit_authoring_md(catalog: dict[str, Any]) -> str:
    """Emit shared/protocol/design-system/authoring.md."""
    layout = catalog["layout"]
    components_layout = layout.get("components", {})
    containers = layout.get("containers", {})

    al = catalog["alignments"]
    al_values = sorted(al["values"])
    arr = catalog.get("arrangements", {})
    arr_values = sorted(arr.get("values", []))

    lines: list[str] = [
        "# Layout & Component Authoring Reference",
        "",
        "> AUTO-GENERATED from `shared/protocol/design-system/design-system.yaml`.",
        "> DO NOT EDIT BY HAND. Run `task design-system:gen` to regenerate.",
        ">",
        "> Audience: **face authors** — LLMs and humans writing `face.tsx` files.",
        "> Renderer implementers: see `rendering.md` instead.",
        "",
        "## What this is",
        "",
        "The catalog encodes the rules every face author can rely on: per-component",
        "default sizing, valid modifier values, recipe patterns. Face authors use the",
        "typed SDK (`from 'moumantai'`) which consumes these closed sets — typos surface",
        "as TypeScript errors at build time.",
        "",
        "## Modifier reference",
        "",
        "Every component accepts these optional modifiers. Omit a modifier to use the",
        "catalog default (almost always what you want).",
        "",
        "### Sizing",
        "",
        "```",
        "width  / height: 'fill' | 'wrap' | <integer dp> | omit (= use default)",
        "weight:           <number>   (numeric flex ratio in a Row/Column)",
        "```",
        "",
        "| Value | When to use |",
        "|---|---|",
        "| omit | Default; works for ~90% of cases |",
        "| `'fill'` | Force cross-axis stretch |",
        "| `'wrap'` | Force content-size |",
        "| `<integer>` | Fixed dp size |",
        "| `weight: <N>` | Inside a Row/Column, claim a proportional share of the remaining main-axis space. Two siblings with `weight: 1` split 50/50; `weight: 1` + `weight: 2` splits 1:2. Has no effect outside a Row/Column. |",
        "",
        "> The `'grow'` keyword is a shorthand for `weight: 1`. Use numeric `weight`",
        "> directly for non-uniform splits (e.g. a 1:2:1 stat row).",
        "",
        "### Alignment",
        "",
        "```",
        f"align: <one of {len(al_values)} values> | omit (= '{al['default']}')",
        "```",
        "",
        "| | Start | Center | End |",
        "|---|---|---|---|",
        "| Top | `'topStart'` | `'topCenter'` | `'topEnd'` |",
        "| Center | `'centerStart'` | `'center'` | `'centerEnd'` |",
        "| Bottom | `'bottomStart'` | `'bottomCenter'` | `'bottomEnd'` |",
        "",
        "### Arrangement (Row / Column main-axis distribution)",
        "",
        "```",
        "vertical_arrangement (Column) / horizontal_arrangement (Row):",
        f"  {' | '.join(repr(v) for v in arr_values)} | omit (= '{arr.get('default', 'start')}')",
        "```",
        "",
        "## Per-component default behavior",
        "",
        "The effective default size when the modifier is omitted, per common parent type.",
        "Atom components (intrinsic=wrap/fixed) behave the same in every parent.",
        "",
    ]

    # Common parents for the table
    COMMON_PARENTS = [
        "Column",
        "Row",
        "Card",
        "Box (background)",
        "Box (overlay)",
        "Scaffold body",
        "root",
    ]

    def resolve_axis_doc(parent: str, intrinsic: str, axis: str) -> str:
        if intrinsic == "wrap":
            return "content"
        if intrinsic == "fixed":
            return "fixed (renderer)"
        # intrinsic == parent
        if parent == "root":
            return "fill (best-effort)"
        if parent in ("Box (background)", "Box (overlay)"):
            slot_key = "background" if "background" in parent else "overlay"
            box_c = containers.get("Box", {})
            slots = box_c.get("slot_policies", {})
            slot = slots.get(slot_key)
            if slot is None:
                return "wrap"
            policy = slot[axis]
        elif parent == "Scaffold body":
            scaffold_c = containers.get("Scaffold", {})
            slots = scaffold_c.get("slot_policies", {})
            slot = slots.get("body")
            if slot is None:
                return "fill"
            policy = slot[axis]
        else:
            c = containers.get(parent)
            if c is None:
                return "fill (best-effort)"
            policy = c.get(f"child_default_{axis}", "cross_axis_wrap")
        if policy == "cross_axis_fill":
            return "fill"
        if policy == "cross_axis_wrap":
            return "content"
        if policy == "none":
            return "content (no policy)"
        return policy

    # Build per-component default-behavior section — iterate all layout.components
    # (which covers every proto variant), pulling variant/fit data from catalog.components
    # where available.
    catalog_comps = catalog.get("components", {})
    for name in sorted(components_layout.keys()):
        lc = components_layout[name]
        intrinsic_w = lc.get("width", "wrap")
        intrinsic_h = lc.get("height", "wrap")
        comp = catalog_comps.get(name, {})

        lines.append(f"### {name}")

        # Intent axes — derived from `intents` block in the catalog. Authors
        # write these directly; the framework maps each (axis...) tuple to a
        # (kind, accent) treatment via resolve<X>Treatment() in the catalog.
        intents = comp.get("intents") if isinstance(comp, dict) else None
        if isinstance(intents, dict):
            defaults = intents.get("defaults", {}) or {}
            for axis_key in sorted(intents.keys()):
                if not axis_key.endswith("_values"):
                    continue
                axis = axis_key[: -len("_values")]
                values = intents[axis_key]
                if not isinstance(values, list) or not values:
                    continue
                default = defaults.get(axis)
                value_str = " | ".join(
                    f"`{v}`" + (" *(default)*" if v == default else "") for v in values
                )
                lines.append(f"**`{axis}`:** {value_str}")

        # Image fit modes
        if name == "Image" and "fit_modes" in comp:
            fit_default = comp.get("default_fit", "contain")
            fit_modes_str = " | ".join(
                f"`{m}`" + (" *(default)*" if m == fit_default else "")
                for m in sorted(comp["fit_modes"])
            )
            lines.append(f"**Fit modes:** {fit_modes_str}")

        # Chip selected-state contract
        if name == "Chip":
            lines.append(
                "**Selected state:** binding `selected:` (regardless of value) "
                "switches the chip from assist-chip styling to filter-chip "
                "styling on every renderer. No author choice needed — the data "
                "shape is the signal."
            )

        # Intrinsic description
        if intrinsic_w == "wrap" and intrinsic_h == "wrap":
            lines.append(
                "**Default size:** content-size in every parent (both axes wrap to content)"
            )
        elif intrinsic_w == "fixed" and intrinsic_h == "fixed":
            lines.append(
                "**Default size:** renderer-defined fixed size in every parent"
            )
        else:
            lines.append("**Default size per parent:**")
            lines.append("")
            lines.append("| Parent | Width | Height |")
            lines.append("|---|---|---|")
            for parent in COMMON_PARENTS:
                w = resolve_axis_doc(parent, intrinsic_w, "width")
                h = resolve_axis_doc(parent, intrinsic_h, "height")
                lines.append(f"| `{parent}` | {w} | {h} |")

        lines.append("")

    lines += [
        "## Recipe sheet",
        "",
        "| Author intent | How to write it |",
        "|---|---|",
        "| Full-width card | `card(id, children)` — default |",
        "| Hero card with corner badge | `box(id, [card(...), badge({align: 'topEnd'})])` — first child becomes the background automatically |",
        "| List filling remaining vertical space | `list(id, items, { height: 'fill' })` inside a column body, or `weight: 1` inside another list/column |",
        "| Two-column proportional split (e.g. away \\| home) | each column with `weight: 1` |",
        "| Asymmetric split (e.g. label takes 2x the value) | `weight: 1`, `weight: 2`, `weight: 1` on the three children |",
        "| Spacer pushing siblings to ends of a Row | a `box(id, [], { weight: 1 })` between them |",
        "| Centered button | `box(id, [button(...)], { content_alignment: 'center' })` |",
        "| Fixed-width sidebar | `column(id, children, { width: 280 })` |",
        "| Force a normally-stretching component to wrap | `card(id, children, { width: 'wrap' })` |",
        "| Image filling its parent | `image(id, src, { width: 'fill' })` |",
        "| Filter chip with selected highlight | `chip(id, label, { selected: pathRef('/selection/x'), action: invokeTool(...) })` — variant defaults to assist; binding `selected` is what activates filter styling |",
        "| Center a Row's contents when the Row spans the parent's width | `row(id, kids, { horizontal_arrangement: 'center' })` — the Row's `horizontal_arrangement` controls main-axis distribution; the parent Column's `horizontal_alignment` does not affect FILL-shaped Row children |",
        "| Card collection in a list | `list(id, items, 'foo_card')` + `card('foo_card', ['foo_inner'])` + `column('foo_inner', [...])` **without** `padding`. The card's own `--moumantai-card-padding` (16dp expanded / 8dp compact) is the content inset; the list applies the catalog gap (8dp expanded / 4dp compact) between consecutive cards. Adding `padding: N` on the inner column doubles the inset and produces visibly bloated tiles. |",
        "",
        "## Pitfalls",
        "",
        "- `weight` only takes effect when the immediate parent is a Row or Column.",
        "  A `weight: 1` on a Column child of a Card does nothing — the Card lays out",
        "  its children stacked vertically with each child taking content height.",
        "- Mixing `weight` and explicit `width` / `height` on the same component:",
        "  the explicit dp wins. Pick one.",
        "- A weighted child whose own children all wrap may *visually* be smaller",
        "  than its allocated slot — the weight gives it the slot, but inner content",
        "  decides how to fill it. Use `horizontal_alignment` / `vertical_alignment`",
        "  on the Column/Row to position content within the slot.",
        "- **Wrap-vs-fill alignment.** A Column's `horizontal_alignment` only",
        "  positions WRAP-intrinsic children (a `text`, a `chip`, a `card` with",
        "  `width: 'wrap'`). FILL-intrinsic children (a `row` — defaults to",
        "  `width: parent`; a `card` — defaults to `width: parent`) already span",
        "  the cross-axis, so the Column's alignment has nothing left to do for",
        "  them. To center the *contents* of a FILL Row, set the Row's own",
        "  `horizontal_arrangement: 'center'`. To center a Card's contents,",
        "  use `box(id, [card(...)], { content_alignment: 'center' })` or shrink",
        "  the Card with `width: 'wrap'`.",
        "- **Nested Row inside a weighted, wrap-cross Column.** A Row child of a",
        "  Column defaults to `width: fill` (catalog policy `Row-in-Column = FILL`).",
        "  If that Column is itself a weighted child of an outer Row, the inner Row",
        "  expands to consume the parent's full width — leaving zero for the outer",
        "  Row's other weighted siblings, which then render invisible. Fix: set",
        "  `width: 'wrap'` on the inner Row so it sizes to its content, freeing",
        "  the outer Row to split remaining space across siblings.",
        "",
    ]

    return "\n".join(lines)


# rendering.md output — renderer implementer reference (generated)


def emit_rendering_md(catalog: dict[str, Any]) -> str:
    """Emit shared/protocol/design-system/rendering.md."""
    layout = catalog["layout"]
    components_layout = layout.get("components", {})
    containers = layout.get("containers", {})
    keywords = sorted(layout.get("size_keywords", []))

    lines: list[str] = [
        "# Layout Rendering Spec",
        "",
        "> AUTO-GENERATED from `shared/protocol/design-system/design-system.yaml`.",
        "> DO NOT EDIT BY HAND. Run `task design-system:gen` to regenerate.",
        ">",
        "> Audience: **renderer implementers** — engineers adding/maintaining the",
        "> Compose phone, Compose Wear, web (CSS), or LVGL ESP32 renderer.",
        "> Face authors: see `authoring.md` instead.",
        "",
        "## What this is",
        "",
        "Every renderer must agree byte-identically on what each `(parent_kind,",
        "slot_index, slot_name, child_kind, child_variant, own_keyword)` combination",
        "resolves to. This document specifies the algorithm, the platform mappings,",
        "and the fallback rules. Conformance is enforced by",
        "`task protocol:test-layout-resolution` against",
        "`shared/protocol/fixtures/layout-resolution/spec.json`.",
        "",
        "## Resolution algorithm",
        "",
        "Pure function: `resolve(parent_kind, slot_index, slot_name, child_kind, child_variant, own_keyword) → SizeResult`",
        "where `SizeResult ∈ { FILL, WRAP, FIXED, GROW }`.",
        "",
        "```",
        "1. own_keyword:",
        "     'fill'  -> FILL",
        "     'wrap'  -> WRAP",
        "     'grow'  -> GROW   (renderer falls back to FILL on cross-axis or",
        "                        non-flex parent — see fallback rules below)",
        "     dp(n)   -> FIXED(n)",
        "2. component intrinsic for this axis:",
        "     'wrap'   -> WRAP",
        "     'fixed'  -> FIXED",
        "     'parent' -> step 3",
        "3. parent's container policy:",
        "     plain       -> child_default_<axis>",
        "     slotted Box -> slot_index == 0 ? 'background' : 'overlay'",
        "     Scaffold    -> slot_name in {body, top_bar, fab}",
        "     cross_axis_fill -> FILL ; cross_axis_wrap -> WRAP ; none -> WRAP",
        "4. root or unknown parent: intrinsic 'parent' -> FILL (best-effort)",
        "```",
        "",
        "Identical for height. Variant-aware sizing (Progress.linear vs circular)",
        "is encoded via the per-component `variant_overrides:` block in the catalog;",
        "the resolver applies the override after the universal width/height lookup,",
        "and renderers may still honor an explicit `modifier.width` to override both.",
        "",
        "## `body_kind` dispatch (Scaffold body container)",
        "",
        "`ScaffoldComponent.body_kind` (enum `BodyKind` — `BODY_KIND_UNSPECIFIED = 0`,",
        "`BODY_KIND_LIST = 1`, `BODY_KIND_CANVAS = 2`) tells every renderer how to wrap",
        "the body slot. The framework owns the body container; face authors stop writing",
        "`column(scroll: true)` on a face's body Column.",
        "",
        "- **LIST** (default, and `UNSPECIFIED` falls through to LIST on every renderer):",
        "  wrap the body in the platform's native lazy/scrollable container. Top-level",
        "  body children become list items. Chin clearance / safe-area / rotary scroll",
        "  free.",
        "- **CANVAS**: render the body inside a bounded, centered, non-scrollable frame.",
        "  Glance faces (one hero ring + caption; weather glance) use this.",
        "",
        "| BodyKind | Phone (M3) | Wear (M3) | ESP32 (LVGL) | Web (CSS) |",
        "|---|---|---|---|---|",
        "| LIST (default) | `LazyColumn` (16dp horizontal padding) | `TransformingLazyColumn` (edge scaling + rotary) | `lv_obj` with `LV_OBJ_FLAG_SCROLLABLE` + vertical flex | `.moumantai-scaffold-body` → `overflow-y: auto` |",
        "| CANVAS | `Box(fillMaxSize, contentAlignment=Center) { Column { … } }` | `Box(fillMaxSize, contentAlignment=Center) { Column { … } }` inside `ScreenScaffold` | `lv_obj` with `LV_FLEX_ALIGN_CENTER` on both axes, scroll flag removed | `.moumantai-scaffold-body--canvas` → `flex; align-items+justify-content: center; overflow: hidden` |",
        "",
        "Wear's `Scaffold.fab` slot is special: when the referenced button has",
        "`variant = 'fab'`, the renderer hoists it into `ScreenScaffold.edgeButton`",
        "(curved bottom-edge primary action) instead of rendering it as a list item.",
        "Other slots / variants render in-flow per the LIST/CANVAS rules above.",
        "",
        "## Sizing keyword → platform mapping",
        "",
        "| Catalog | Compose | LVGL | CSS |",
        "|---|---|---|---|",
        "| FILL | `Modifier.fillMaxWidth()` | `LV_PCT(100)` | `width: 100% / align-self: stretch` |",
        "| WRAP | `Modifier.wrapContentWidth()` | `LV_SIZE_CONTENT` | `width: auto` |",
        "| GROW | no-op marker; the SDK normalizes `'grow'` to `weight: 1` and the parent Row/Column applies the weight via the renderer's outer-modifier hook | `lv_obj_set_flex_grow(obj, 1)` | `flex: 1` |",
        "| FIXED(n) | `Modifier.width(n.dp)` | `lv_obj_set_width(obj, n)` | `width: ${n}px` |",
        "",
        "### Numeric `weight` (canonical)",
        "",
        "The proto carries an optional numeric `weight` field on `Modifier`. Renderers",
        "extract it inside Row/Column iteration and apply it to the child:",
        "",
        "- **Compose (Android, Wear)**: `Modifier.weight(N)` is only callable inside",
        "  RowScope/ColumnScope, but the per-component `*Renderer` builds its own",
        "  modifier from scratch and has no scope access. The Row/ColumnRenderer",
        "  therefore wraps the child in a tiny `Box(Modifier.weight(N), propagateMinConstraints = true) { childRender() }`.",
        "  The Box reads as a transparent slot allocator: the parent Row/Column sees",
        "  the weight parent data and gives the Box its share of the main axis;",
        "  `propagateMinConstraints = true` forwards the slot's minWidth/minHeight to",
        "  the inner child so a WRAP-policy Column (the catalog default for",
        "  Column-in-Row) doesn't collapse to intrinsic-zero. The Box has no padding",
        "  or content alignment of its own, so it adds no visible chrome.",
        "- **CSS (web)**: `style.flex = weight`.",
        "- **LVGL (ESP32)**: `lv_obj_set_flex_grow(obj, weight)`.",
        "",
        "Same table for height with axis swapped.",
        "",
        "## Component intrinsics",
        "",
        "Every component's default sizing when no parent context is available (root or unknown parent).",
        "`parent` intrinsic resolves to FILL at root (best-effort). Sourced from `layout.components`.",
        "",
        "| Component | Width intrinsic | Height intrinsic |",
        "|---|---|---|",
    ]

    for cname, c in sorted_layout_components(layout):
        lines.append(f"| {cname} | `{c['width']}` | `{c['height']}` |")

    lines += [
        "",
        "## Container policies",
        "",
        "Sourced from `layout.containers`. These apply when a child has `parent` intrinsic",
        "and the parent is a known container.",
        "",
    ]

    for cname, c in sorted_containers(layout):
        lines.append(f"### {cname}")
        if "slot_policies" in c:
            lines.append("")
            lines.append("Slotted container — slot determines child sizing.")
            lines.append("")
            lines.append("| Slot | Width policy | Height policy |")
            lines.append("|---|---|---|")
            for slot_key in sorted(c["slot_policies"].keys()):
                slot = c["slot_policies"][slot_key]
                lines.append(
                    f"| `{slot_key}` | `{slot['width']}` | `{slot['height']}` |"
                )
        else:
            dw = c.get("child_default_width", "—")
            dh = c.get("child_default_height", "—")
            lines.append(f"Child default width: `{dw}` / height: `{dh}`")
            gaps = c.get("child_gaps")
            if gaps:
                lines.append("")
                lines.append(
                    "Gap between consecutive children (spacing-token names; `none` = literal 0):"
                )
                lines.append("")
                lines.append("| Child variant | Gap token |")
                lines.append("|---|---|")
                for k in sorted(k for k in gaps.keys() if k != "default"):
                    lines.append(f"| `{k}` | `{gaps[k]}` |")
                if "default" in gaps:
                    lines.append(f"| _default_ | `{gaps['default']}` |")
        lines.append("")

    lines += [
        "## Fallback rules",
        "",
        "- Unknown sizing keyword → treat as omitted (use catalog default).",
        "- Unknown alignment → fall back to `topStart` (catalog default).",
        "- Unknown arrangement → fall back to `start` (catalog default).",
        "- Unknown image fit → look up `fit_aliases`, else fall back to `contain`.",
        "- Unknown variant → use `default_variant` from catalog.",
        "",
        "These fallbacks are forward-compat: future SDK could ship a new keyword and",
        "old clients degrade gracefully without crashing.",
        "",
        "## Per-platform chrome conventions",
        "",
        "The catalog encodes layout *contracts*, not platform values. Each renderer",
        "picks its idiomatic value:",
        "",
        "| Convention | Phone (M3) | Wear (M3) | ESP32 (LVGL) | Web (CSS) |",
        "|---|---|---|---|---|",
        "| Scaffold body horizontal padding | 16dp | 4dp | panel-dependent | container-aware |",
        "| Top bar height | 56dp (M3) | wear-default | panel-dependent | platform-default |",
        "",
        "Reviewers cross-checking visual consistency: if a value in this table changes,",
        "update both the renderer and this doc.",
        "",
        "## Conformance fixture obligation",
        "",
        "Every fixture row in `shared/protocol/fixtures/layout-resolution/spec.json`",
        "is binding across all 4 renderers (web + phone + wear + ESP32). Adding a",
        "new component or container to the catalog requires adding fixture rows",
        "covering at minimum:",
        "",
        "- Default in Column (cross-axis-stretching parent)",
        "- Default in Row (cross-axis-wrapping parent)",
        "- One explicit-keyword override (e.g., `width: 'fill'` overriding the parent default)",
        "",
        "`task protocol:test-layout-resolution` runs the fixture against all legs",
        "and fails closed on any disagreement.",
        "",
        "## Renderer coverage lint (drift sentinel)",
        "",
        "Beyond layout-resolution, every renderer must reference every proto field on",
        "every `ComponentDef` variant — otherwise a wire-declared field silently drops",
        "on that platform (the silent-drop bug class). The static-analysis script",
        "`shared/protocol/scripts/lint-renderer-coverage.py` scans each renderer's",
        "source and reports:",
        "",
        "- **Missing dispatch**: a variant that has no `case`/`when` branch.",
        "- **Dropped fields**: a proto field that doesn't appear in the renderer's",
        "  case body (per-renderer case convention: snake_case for Phone/Wear/ESP32,",
        "  camelCase for Web).",
        "",
        "Intentional platform divergences (e.g. Wear has no soft keyboard, so",
        "`TextField.keyboard_type` is moot) live in",
        "`shared/protocol/scripts/coverage-allowlist.yaml` with a documented reason.",
        "Every allowlist entry is reviewed at PR time.",
        "",
        "Run via `task protocol:lint-coverage`. Not wired as a hard CI gate; humans",
        "run it before merging proto/renderer changes.",
        "",
        "Known limitations of static word-matching: false negatives on context-",
        "sensitive drops (e.g. a field referenced in one variant's branch but not",
        "another). Reviewers compensate; the lint catches the broadly-dropped class.",
        "",
        "## Adding a new component",
        "",
        "When a new `<Name>Component` variant is added to `ComponentDef.component`:",
        "",
        "1. Add `<Name>: { width: <kind>, height: <kind> }` to `layout.components` in",
        "   the catalog YAML.",
        "2. If it's a container, add a `layout.containers.<Name>` entry (plain or",
        "   slotted as appropriate).",
        "3. Add fixture rows.",
        "",
        "`build-design-system.py` fails closed if step 1 is skipped — every",
        "proto-side component variant MUST appear in `layout.components`.",
        "",
    ]

    return "\n".join(lines)


# Main


def write_or_check(path: Path, content: str, check: bool) -> bool:
    """Write `content` to `path`. In check mode, return True iff stale."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if check:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        if existing != content:
            print(f"  [STALE] {path.relative_to(ROOT)}")
            return True
        print(f"  [ok]    {path.relative_to(ROOT)}")
        return False
    if path.exists() and path.read_text(encoding="utf-8") == content:
        print(f"  [unchanged] {path.relative_to(ROOT)}")
        return False
    path.write_text(content, encoding="utf-8")
    print(f"  [generated] {path.relative_to(ROOT)}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail with nonzero exit if any output is stale (no writes).",
    )
    args = parser.parse_args()

    print(f"Loading {YAML_PATH.relative_to(ROOT)}...")
    catalog = load_catalog()

    print("Validating layout block against proto...")
    validate_layout(catalog)

    print("Generating outputs:")
    outputs = [
        (OUT_DIR / "design-system.ts", emit_ts(catalog)),
        (OUT_DIR / "DesignSystem.kt", emit_kotlin(catalog)),
        (OUT_DIR / "design_system.h", emit_c_header(catalog)),
        (OUT_DIR / "design_system.c", emit_c_source(catalog)),
        (OUT_DIR / "design-system.css", emit_css(catalog)),
        (OUT_DIR / "sdk-types.ts", emit_sdk_types(catalog)),
        (DESIGN_SYSTEM_DIR / "authoring.md", emit_authoring_md(catalog)),
        (DESIGN_SYSTEM_DIR / "rendering.md", emit_rendering_md(catalog)),
    ]
    stale = False
    for path, content in outputs:
        if write_or_check(path, content, args.check):
            stale = True

    if args.check and stale:
        print("\nERROR: design-system outputs are stale. Run `task design-system:gen`.")
        return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
