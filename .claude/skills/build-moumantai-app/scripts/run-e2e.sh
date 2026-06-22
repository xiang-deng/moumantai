#!/usr/bin/env bash
# Run the E2E (Playwright) test for a given mini app.
# Wraps scripts/with_server.py so the dev server boots, waits for readiness,
# runs the Playwright test, then tears down.
#
# Usage: bash .claude/skills/build-moumantai-app/scripts/run-e2e.sh <app-id>

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <app-id>" >&2
  exit 2
fi

APP_ID="$1"
APP_ID_UNDERSCORE="${APP_ID//-/_}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$REPO_ROOT"
exec python scripts/with_server.py \
  --server "cd server && npm run dev" --port 3000 \
  -- python "server/tests/e2e/test_${APP_ID_UNDERSCORE}.py"
