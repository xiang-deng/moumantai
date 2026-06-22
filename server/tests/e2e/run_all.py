#!/usr/bin/env python3
"""Run all E2E tests."""

import subprocess
import sys
import glob
import os

test_dir = os.path.dirname(os.path.abspath(__file__))
test_files = sorted(glob.glob(os.path.join(test_dir, "test_*.py")))

if not test_files:
    print("No E2E tests found (tests/e2e/test_*.py)")
    sys.exit(0)

failed = []
for test_file in test_files:
    print(f"\n{'=' * 60}")
    print(f"Running: {os.path.basename(test_file)}")
    print(f"{'=' * 60}")
    result = subprocess.run([sys.executable, test_file])
    if result.returncode != 0:
        failed.append(test_file)

print(f"\n{'=' * 60}")
print(f"Results: {len(test_files) - len(failed)}/{len(test_files)} passed")
if failed:
    print("Failed:")
    for f in failed:
        print(f"  - {os.path.basename(f)}")
    sys.exit(1)
else:
    print("All E2E tests passed!")
