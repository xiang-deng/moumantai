#!/usr/bin/env python3
"""Soft-failing wrapper around `buf breaking`.

Exits non-zero only on genuine breaking changes. The one soft-skip: when
master has no .proto baseline yet ("had no .proto files"), the first commit
can't be compared — treated as OK; the next PR becomes the baseline.

Usage:
  uv run python scripts/check-breaking.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROTO_DIR = ROOT / "shared" / "protocol" / "proto"


def main() -> int:
    buf = ROOT / "node_modules" / "@bufbuild" / "buf" / "bin" / "buf"
    cmd = [
        "node",
        str(buf),
        "breaking",
        "--against",
        "../../../.git#branch=master,subdir=shared/protocol/proto",
    ]
    proc = subprocess.run(cmd, cwd=str(PROTO_DIR), capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    print(out, end="")
    if proc.returncode == 0:
        return 0
    if "had no .proto files" in out:
        print("\nnote: master has no .proto baseline yet; treating as ok.")
        return 0
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
