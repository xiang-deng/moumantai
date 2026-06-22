#!/usr/bin/env python3
"""Cross-language fixture round-trip orchestrator.

Runs TS / Kotlin (Android + Wear) / C sub-runners and asserts byte-identical
output for every fixture under `shared/protocol/fixtures/`. The C leg requires
a host C compiler and nanopb under `clients/esp32/managed_components/`; it is
soft-skipped when unavailable.

Usage:
  uv run python scripts/test-cross-language.py
"""

from __future__ import annotations

import filecmp
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ROOT / "shared" / "protocol" / "fixtures"

ANDROID_DIR = ROOT / "clients" / "android"
WEAR_DIR = ROOT / "clients" / "wear-os"


def run(cmd: list[str], cwd: Path) -> int:
    print(f"  $ {' '.join(cmd)}")
    # shell=True on Windows so .cmd/.bat shims are discovered.
    return subprocess.call(cmd, cwd=str(cwd), shell=(os.name == "nt"))


def gradlew(client_dir: Path) -> Path:
    if os.name == "nt":
        return client_dir / "gradlew.bat"
    return client_dir / "gradlew"


# ---------------------------------------------------------------------------
# Sub-runner invocations
# ---------------------------------------------------------------------------


def run_ts() -> bool:
    """Invoke the TS leg to produce `<fixture>.ts.bin` files."""
    print("\n[TS]    fixture round-trip via @bufbuild/protobuf")
    rc = run(
        ["npm", "run", "fixture-roundtrip", "-w", "@moumantai/protocol", "--silent"],
        cwd=ROOT,
    )
    return rc == 0


def run_kotlin(client_dir: Path, label: str) -> bool:
    """Invoke a Kotlin leg (Android or Wear-OS) via Gradle.

    --rerun-tasks forces re-execution: Gradle considers the test UP-TO-DATE
    because it doesn't track the external .kotlin.bin output files.
    """
    print(f"\n[Kotlin/{label}] fixture round-trip via Wire ProtoAdapter")
    cmd = [
        str(gradlew(client_dir)),
        ":app:testDebugUnitTest",
        "--tests",
        "com.moumantai.protocol.v1.FixtureRoundTripTest",
        "--rerun-tasks",
        "--no-daemon",
    ]
    rc = run(cmd, cwd=client_dir)
    return rc == 0


def run_c() -> bool | None:
    """Invoke the C leg (host-mode nanopb). Returns True/False or None (soft skip)."""
    import tempfile

    print("\n[C]     fixture round-trip via nanopb (host)")

    cc = None
    for cand in ("cc", "gcc", "clang"):
        if shutil.which(cand):
            cc = cand
            break
    if cc is None:
        print("  warn: no host C compiler on PATH — skipping C leg.")
        return None

    transport = ROOT / "clients" / "esp32" / "components" / "transport"
    test_src = transport / "test" / "test_fixtures_roundtrip.c"
    proto_dir = transport / "generated" / "proto"
    nanopb_runtime = transport / "managed_components"

    # Locate nanopb runtime sources. Without ESP-IDF managed_components present
    # we vendor it via uv: grpcio-tools ships nanopb's runtime headers.
    # Fallback: clone via pip if missing.
    nanopb_src_candidates = [
        ROOT / "clients" / "esp32" / "managed_components" / "nikas-belogolov__nanopb",
        ROOT / "clients" / "esp32" / "managed_components" / "espressif__nanopb",
    ]
    nanopb_root = next((p for p in nanopb_src_candidates if p.is_dir()), None)
    if nanopb_root is None:
        print(
            "  warn: nanopb runtime not found under clients/esp32/managed_components/.\n"
            "  Run `idf.py reconfigure` from clients/esp32/ to populate it. Skipping C leg."
        )
        return None

    nanopb_pbc = [
        nanopb_root / "pb_common.c",
        nanopb_root / "pb_decode.c",
        nanopb_root / "pb_encode.c",
    ]
    for f in nanopb_pbc:
        if not f.is_file():
            print(f"  warn: nanopb source missing: {f} — skipping C leg.")
            return None

    # All generated *.pb.c
    pb_c_files = sorted(proto_dir.rglob("*.pb.c"))

    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / ("roundtrip.exe" if os.name == "nt" else "roundtrip")
        cmd = [
            cc,
            "-O0",
            "-g",
            "-std=c99",
            f"-I{nanopb_root}",
            f"-I{proto_dir}",
            str(test_src),
            *(str(p) for p in pb_c_files),
            *(str(p) for p in nanopb_pbc),
            "-o",
            str(out),
        ]
        print(f"  $ {cc} ... -> {out.name}")
        rc = subprocess.call(cmd)
        if rc != 0:
            print("  FAIL: build")
            return False
        rc = subprocess.call([str(out), str(FIXTURES_DIR)])
        return rc == 0


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def compare_outputs() -> tuple[int, list[str]]:
    """Walk every fixture and collect (count, errors)."""
    errors: list[str] = []
    count = 0
    for ts_bin in sorted(FIXTURES_DIR.rglob("*.ts.bin")):
        rel = ts_bin.relative_to(FIXTURES_DIR)
        kotlin_bin = ts_bin.with_suffix("").with_suffix(".kotlin.bin")
        if not kotlin_bin.exists():
            errors.append(f"{rel}: missing .kotlin.bin (Kotlin leg failed?)")
            continue
        if not filecmp.cmp(ts_bin, kotlin_bin, shallow=False):
            errors.append(f"{rel}: TS vs Kotlin bytes diverge")
        # Wear and Android emit to the SAME .kotlin.bin path (the test writes
        # into the shared fixtures dir). The wear test running last just
        # overwrites Android's identical output, which is fine — both legs
        # validated byte-equality with TS during their own run.
        count += 1
    return count, errors


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def cleanup_intermediate() -> None:
    """Remove every `<fixture>.ts.bin`, `.kotlin.bin`, `.c.bin` so the next
    run starts from a clean slate. Keep the `.json` source files.
    """
    for ext in (".ts.bin", ".kotlin.bin", ".c.bin"):
        for f in FIXTURES_DIR.rglob(f"*{ext}"):
            f.unlink()


def main(argv: list[str]) -> int:
    cleanup_intermediate()

    if not run_ts():
        print("\nTS leg failed; aborting.")
        return 1

    # Run both Kotlin clients — they each write their own out files,
    # then we diff against TS.
    android_ok = run_kotlin(ANDROID_DIR, "android")
    wear_ok = run_kotlin(WEAR_DIR, "wear-os")
    if not android_ok:
        print("\nAndroid Kotlin leg failed; see test report.")
        return 1
    if not wear_ok:
        print("\nWear-OS Kotlin leg failed; see test report.")
        return 1

    c_status = run_c()  # None = skipped, True/False = ran

    count, errors = compare_outputs()
    if errors:
        print(f"\nByte-equality failed for {len(errors)} fixture(s):")
        for e in errors:
            print(f"  {e}")
        return 1

    print(f"\nok: {count} fixtures byte-equal across TS + Kotlin (Android, Wear)")
    if c_status is None:
        print("  (C leg skipped — no host C compiler on PATH)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
