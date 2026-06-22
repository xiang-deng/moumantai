#!/usr/bin/env python3
"""
Run idf.py from a shell that would otherwise be rejected (MSys/MinGW).

Strips MSYSTEM from the environment, prepends the bundled ESP-IDF tool
directories to PATH so CMake / ninja / xtensa-gcc resolve correctly, and
runs idf.py via runpy so we bypass the __main__-level MSYSTEM guard.

Configuration (set via env or `.mise.local.toml`):
    IDF_PATH               — root of the cloned esp-idf tree (default: C:\\esp\\esp-idf on Windows)
    IDF_PYTHON_ENV_PATH    — Espressif Python venv for idf.py
                             (default: %USERPROFILE%\\.espressif\\python_env\\idf5.4_py3.10_env)
    IDF_TOOLS_PATH         — Espressif tool downloads (default: %USERPROFILE%\\.espressif\\tools)

Usage:
    python tools/run_idf.py build
    python tools/run_idf.py -p COM3 flash monitor
"""

from __future__ import annotations

import os
import pathlib
import runpy
import sys


def _default_idf_path() -> pathlib.Path:
    if os.name == "nt":
        return pathlib.Path(r"C:\esp\esp-idf")
    return pathlib.Path.home() / "esp" / "esp-idf"


def _default_espressif_root() -> pathlib.Path:
    return pathlib.Path.home() / ".espressif"


IDF_PATH = pathlib.Path(os.environ.get("IDF_PATH") or _default_idf_path())
IDF_PYTHON_ENV = pathlib.Path(
    os.environ.get("IDF_PYTHON_ENV_PATH")
    or (_default_espressif_root() / "python_env" / "idf5.4_py3.10_env")
)
TOOLS_ROOT = pathlib.Path(
    os.environ.get("IDF_TOOLS_PATH") or (_default_espressif_root() / "tools")
)


def find_tool_bin(name: str, subpath: str) -> pathlib.Path | None:
    """Pick the single installed version under tools/<name>/<ver>/<subpath>."""
    root = TOOLS_ROOT / name
    if not root.is_dir():
        return None
    versions = [p for p in root.iterdir() if p.is_dir()]
    if not versions:
        return None
    versions.sort()
    return versions[-1] / subpath


def main() -> int:
    python_scripts = IDF_PYTHON_ENV / ("Scripts" if os.name == "nt" else "bin")
    extra_path_parts = [
        python_scripts,
        find_tool_bin("xtensa-esp-elf", os.path.join("xtensa-esp-elf", "bin")),
        find_tool_bin("riscv32-esp-elf", os.path.join("riscv32-esp-elf", "bin")),
        find_tool_bin("cmake", "bin"),
        find_tool_bin("ninja", ""),
        find_tool_bin("ccache", "ccache-4.10.2-windows-x86_64"),
        find_tool_bin("esp32ulp-elf", os.path.join("esp32ulp-elf", "bin")),
        find_tool_bin("idf-exe", "1.0.3"),
        IDF_PATH / "tools",
    ]
    prepend = os.pathsep.join(str(p) for p in extra_path_parts if p and p.exists())

    env_path = os.environ.get("PATH", "")
    os.environ["PATH"] = prepend + os.pathsep + env_path
    os.environ["IDF_PATH"] = str(IDF_PATH)
    os.environ["IDF_PYTHON_ENV_PATH"] = str(IDF_PYTHON_ENV)
    os.environ.pop("MSYSTEM", None)

    rom_elf = find_tool_bin("esp-rom-elfs", "")
    if rom_elf:
        os.environ["ESP_ROM_ELF_DIR"] = str(rom_elf).rstrip(os.sep) + os.sep

    idf_tools_dir = str(IDF_PATH / "tools")
    if idf_tools_dir not in sys.path:
        sys.path.insert(0, idf_tools_dir)

    sys.argv = ["idf.py"] + sys.argv[1:]
    try:
        runpy.run_path(str(IDF_PATH / "tools" / "idf.py"), run_name="__main__")
    except SystemExit as e:
        return int(e.code) if e.code is not None else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
