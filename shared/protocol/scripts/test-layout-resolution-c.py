#!/usr/bin/env python3
"""Host-mode conformance test: layout-resolution catalog C implementation.

Compiles shared/protocol/design-system/generated/design_system.c (plain C,
no ESP-IDF required) with a small inline harness generated from spec.json,
then runs it and asserts every case matches the expected output.

Requirements:
  - gcc (or cl.exe on Windows) available on PATH
  - Python 3.8+

Usage:
  uv run python shared/protocol/scripts/test-layout-resolution-c.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent  # repo root
DESIGN_SYS_DIR = ROOT / "shared" / "protocol" / "design-system" / "generated"
SPEC_PATH = (
    ROOT / "shared" / "protocol" / "fixtures" / "layout-resolution" / "spec.json"
)

# ---------------------------------------------------------------------------
# String-to-enum mapping (mirrors design_system.h)
# ---------------------------------------------------------------------------

EXPECTED_MAP = {
    "fill": "DS_LAYOUT_FILL",
    "wrap": "DS_LAYOUT_WRAP",
    "fixed": "DS_LAYOUT_FIXED",
    "grow": "DS_LAYOUT_GROW",
}

# ---------------------------------------------------------------------------
# Harness C template
# ---------------------------------------------------------------------------

HARNESS_TMPL = """\
#include "design_system.h"
#include <stdio.h>
#include <string.h>

static const char *size_name(ds_layout_size_t s) {
    switch (s) {
    case DS_LAYOUT_FILL:  return "fill";
    case DS_LAYOUT_WRAP:  return "wrap";
    case DS_LAYOUT_FIXED: return "fixed";
    case DS_LAYOUT_GROW:  return "grow";
    default:              return "unknown";
    }
}

int main(void) {
    int pass = 0, fail = 0;
%(cases)s
    printf("\\nC harness: %%d passed, %%d failed\\n", pass, fail);
    return fail > 0 ? 1 : 0;
}
"""

CASE_TMPL = """\
    /* {name} */
    {{
        const char *parent_kind = {parent_kind};
        int slot_index = {slot_index};
        const char *slot_name = {slot_name};
        const char *child_kind = {child_kind};
        const char *child_variant = {child_variant};
        const char *own_w = {own_width_keyword};
        const char *own_h = {own_height_keyword};
        ds_layout_size_t got_w = ds_layout_resolve_width(parent_kind, slot_index, slot_name, child_kind, child_variant, own_w);
        ds_layout_size_t got_h = ds_layout_resolve_height(parent_kind, slot_index, slot_name, child_kind, child_variant, own_h);
        int ok_w = (got_w == {expected_width}), ok_h = (got_h == {expected_height});
        if (ok_w && ok_h) {{
            pass++;
        }} else {{
            fail++;
            if (!ok_w) printf("FAIL {name}: width expected={expected_width_s} got=%s\\n", size_name(got_w));
            if (!ok_h) printf("FAIL {name}: height expected={expected_height_s} got=%s\\n", size_name(got_h));
        }}
    }}
"""


def c_str(v: str | None) -> str:
    """Format a Python string or None as a C string literal or NULL."""
    if v is None:
        return "NULL"
    return f'"{v}"'


def build_harness(cases: list[dict]) -> str:
    parts: list[str] = []
    for case in cases:
        if "$section" in case:
            continue
        ew = EXPECTED_MAP[case["expected_width"]]
        eh = EXPECTED_MAP[case["expected_height"]]
        parts.append(
            CASE_TMPL.format(
                name=case["name"],
                parent_kind=c_str(case.get("parent_kind")),
                slot_index=case.get("slot_index", 0),
                slot_name=c_str(case.get("slot_name")),
                child_kind=c_str(case.get("child_kind")),
                child_variant=c_str(case.get("child_variant")),
                own_width_keyword=c_str(case.get("own_width_keyword")),
                own_height_keyword=c_str(case.get("own_height_keyword")),
                expected_width=ew,
                expected_height=eh,
                expected_width_s=case["expected_width"],
                expected_height_s=case["expected_height"],
            )
        )
    return HARNESS_TMPL % {"cases": "".join(parts)}


def find_compiler() -> list[str] | None:
    """Return a compiler invocation prefix, or None if nothing found."""
    for cc in ("gcc", "cc", "clang"):
        if shutil.which(cc):
            return [cc]
    # Windows: try cl.exe (MSVC)
    if shutil.which("cl"):
        return ["cl"]
    # Windows with WSL: try wsl gcc as a last resort
    if os.name == "nt" and shutil.which("wsl"):
        result = subprocess.run(["wsl", "which", "gcc"], capture_output=True, text=True)
        if result.returncode == 0:
            return ["wsl", "gcc"]
    return None


def _wsl_path(win_path: Path) -> str:
    """Convert a Windows absolute path to a WSL mount path."""
    s = str(win_path).replace("\\", "/")
    # C:\foo\bar → /mnt/c/foo/bar
    if len(s) >= 2 and s[1] == ":":
        drive = s[0].lower()
        rest = s[2:]
        return f"/mnt/{drive}{rest}"
    return s


def compile_and_run(harness_src: str) -> tuple[bool, str]:
    """Write harness to a tempdir, compile, run. Returns (ok, output)."""
    compiler = find_compiler()
    if compiler is None:
        return False, "No C compiler (gcc/cc/clang/cl) found on PATH — skipping C leg"

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        harness_c = tmp / "harness.c"
        harness_c.write_text(harness_src, encoding="utf-8")

        design_c = DESIGN_SYS_DIR / "design_system.c"

        is_wsl = compiler[0] == "wsl"
        is_msvc = compiler == ["cl"]

        if is_wsl:
            # Run compiler inside WSL; translate Windows paths to /mnt/X/...
            exe_wsl = _wsl_path(tmp / "harness")
            cmd = [
                "wsl",
                "gcc",
                f"-I{_wsl_path(DESIGN_SYS_DIR)}",
                _wsl_path(harness_c),
                _wsl_path(design_c),
                "-o",
                exe_wsl,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                return False, f"Compile failed:\n{result.stdout}\n{result.stderr}"
            result = subprocess.run(["wsl", exe_wsl], capture_output=True, text=True)
            output = result.stdout + result.stderr
            return result.returncode == 0, output

        exe = tmp / ("harness.exe" if os.name == "nt" else "harness")

        if is_msvc:
            cmd = [
                "cl",
                "/nologo",
                f"/I{DESIGN_SYS_DIR}",
                str(harness_c),
                str(design_c),
                f"/Fe{exe}",
                "/link",
            ]
        else:
            cmd = compiler + [
                f"-I{DESIGN_SYS_DIR}",
                str(harness_c),
                str(design_c),
                "-o",
                str(exe),
            ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return False, f"Compile failed:\n{result.stdout}\n{result.stderr}"

        result = subprocess.run([str(exe)], capture_output=True, text=True)
        output = result.stdout + result.stderr
        return result.returncode == 0, output


def main() -> int:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    cases = spec["cases"]
    real_cases = [c for c in cases if "$section" not in c]
    print(f"[C] layout-resolution conformance: {len(real_cases)} cases")

    harness_src = build_harness(cases)
    ok, output = compile_and_run(harness_src)

    for line in output.splitlines():
        print(f"  {line}")

    if not ok:
        if "No C compiler" in output:
            print(f"  WARNING: {output}")
            print("  Skipping C leg — install gcc to enable.")
            return 0  # non-fatal: not a test failure, just unavailable toolchain
        print("\n[C] FAILED")
        return 1

    print("[C] PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
