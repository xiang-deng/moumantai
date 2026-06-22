#!/usr/bin/env bash
# Run the integration test for a given mini app.
# Usage: bash .claude/skills/build-moumantai-app/scripts/run-integration.sh <app-id>

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <app-id>" >&2
  exit 2
fi

APP_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$REPO_ROOT/server"
exec npm test -- --run "tests/integration/${APP_ID}.test.ts"
