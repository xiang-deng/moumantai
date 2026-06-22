#!/usr/bin/env bash
#
# Phase-2 scaffolder. Creates apps/<id>/ and the test stubs from the skill's
# templates, substituting placeholders. Idempotent-safe: refuses to overwrite.
#
# Usage:
#   bash .claude/skills/build-moumantai-app/scripts/scaffold.sh \
#     <app-id> "<Display Name>" "<description>" [icon]
#
# Example:
#   bash .claude/skills/build-moumantai-app/scripts/scaffold.sh \
#     diet-tracker "Diet Tracker" "Log meals and daily calories" restaurant

set -euo pipefail

usage() {
  cat <<EOF
Usage:
  $0 <app-id> "<Display Name>" "<description>" [icon]
  $0 face <app-id> <face-id> "<Face Label>"

Examples:
  # Create a new app skeleton (use once per app, at Phase 2):
  $0 diet-tracker "Diet Tracker" "Log meals and daily calories" restaurant

  # Create a new face subdirectory inside an existing app (use in Phase 5,
  # once per face listed in design.md's face inventory):
  $0 face diet-tracker today "Today"
  $0 face diet-tracker history "History"
EOF
  exit 2
}

if [[ $# -lt 1 ]]; then usage; fi

# --- "face" subcommand: scaffold a single face subdirectory ---------------
if [[ "$1" == "face" ]]; then
  if [[ $# -lt 4 ]]; then usage; fi
  APP_ID="$2"
  FACE_ID="$3"
  FACE_LABEL="$4"

  if [[ ! "$APP_ID" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "error: app-id must match /^[a-z][a-z0-9-]*\$/, got: $APP_ID" >&2
    exit 2
  fi
  if [[ ! "$FACE_ID" =~ ^[a-z][a-z0-9_]*$ ]]; then
    echo "error: face-id must match /^[a-z][a-z0-9_]*\$/ (singular, snake_case), got: $FACE_ID" >&2
    exit 2
  fi

  # Derived: face-id camelCase (e.g. 'daily_summary' -> 'dailySummary')
  FACE_CAMEL=""
  IFS='_' read -ra FPARTS <<< "$FACE_ID"
  first=1
  for p in "${FPARTS[@]}"; do
    if [[ $first -eq 1 ]]; then
      FACE_CAMEL+="$p"; first=0
    else
      FACE_CAMEL+="$(tr '[:lower:]' '[:upper:]' <<< ${p:0:1})${p:1}"
    fi
  done

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"

  FACE_DIR="$REPO_ROOT/apps/$APP_ID/faces/$FACE_ID"
  if [[ -e "$FACE_DIR" ]]; then
    echo "error: $FACE_DIR already exists" >&2
    exit 2
  fi
  if [[ ! -d "$REPO_ROOT/apps/$APP_ID" ]]; then
    echo "error: apps/$APP_ID does not exist. Scaffold the app first." >&2
    exit 2
  fi

  mkdir -p "$FACE_DIR"

  sub_face() {
    local src="$1" dst="$2"
    sed \
      -e "s|__APP_ID__|$APP_ID|g" \
      -e "s|__APP_NAME__|__APP_NAME_SEE_MANIFEST__|g" \
      -e "s|__FACE_ID__|$FACE_ID|g" \
      -e "s|__FACE_LABEL__|$FACE_LABEL|g" \
      -e "s|__FACE_ID_CAMEL__|$FACE_CAMEL|g" \
      "$src" > "$dst"
  }

  sub_face "$SKILL_DIR/templates/face.resolve.ts.tmpl"      "$FACE_DIR/$FACE_ID.resolve.ts"
  sub_face "$SKILL_DIR/templates/face.parts.ts.tmpl"        "$FACE_DIR/$FACE_ID.parts.ts"
  sub_face "$SKILL_DIR/templates/face.compact.ts.tmpl"      "$FACE_DIR/$FACE_ID.compact.ts"
  sub_face "$SKILL_DIR/templates/face.expanded.ts.tmpl"     "$FACE_DIR/$FACE_ID.expanded.ts"

  cat <<EOF

scaffolded: apps/$APP_ID/faces/$FACE_ID/
  $FACE_ID.resolve.ts     (shared resolver)
  $FACE_ID.parts.ts       (shared components — optional; delete if unused)
  $FACE_ID.compact.ts     (compact variant — clients at ≤240dp)
  $FACE_ID.expanded.ts    (expanded variant — phone / tablet / wide web)

next:
  1. Fill $FACE_ID.resolve.ts to match the shape declared in design.md.
  2. Fill $FACE_ID.parts.ts with shared components (or delete if not needed).
  3. Fill $FACE_ID.compact.ts (compact IA: ≤3 visible items, glance-first)
     and $FACE_ID.expanded.ts (expanded IA: dense, TopBar, multi-section).
  4. Add a resolver test case to server/tests/integration/$APP_ID.test.ts.
  5. In apps/$APP_ID/index.ts, import the compact variant by default and push to faces: [...]:
        import ${FACE_CAMEL}Face from './faces/$FACE_ID/$FACE_ID.compact.js'
        ...
        faces: [..., ${FACE_CAMEL}Face],
     Do NOT import or register the .expanded variant — the framework auto-loads it.
EOF
  exit 0
fi

# --- App-skeleton (original default flow) ---------------------------------

if [[ $# -lt 3 ]]; then usage; fi

APP_ID="$1"
APP_NAME="$2"
APP_DESC="$3"
ICON="${4:-star}"

# Validate app-id
if [[ ! "$APP_ID" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "error: app-id must match /^[a-z][a-z0-9-]*\$/, got: $APP_ID" >&2
  exit 2
fi
if [[ "$APP_ID" == "home" ]]; then
  echo "error: app-id 'home' is reserved" >&2
  exit 2
fi

# Derived names
APP_ID_UNDERSCORE="${APP_ID//-/_}"
APP_ID_SNAKE="$APP_ID_UNDERSCORE"
# PascalName: capitalize words split on '-'
PASCAL_NAME=""
IFS='-' read -ra PARTS <<< "$APP_ID"
for part in "${PARTS[@]}"; do
  PASCAL_NAME+="$(tr '[:lower:]' '[:upper:]' <<< ${part:0:1})${part:1}"
done

# Locate skill and repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"

APP_DIR="$REPO_ROOT/apps/$APP_ID"
TEST_INT="$REPO_ROOT/server/tests/integration/$APP_ID.test.ts"
TEST_E2E="$REPO_ROOT/server/tests/e2e/test_${APP_ID_UNDERSCORE}.py"

if [[ -e "$APP_DIR" ]]; then
  echo "error: $APP_DIR already exists. Remove it first if you want to re-scaffold." >&2
  exit 2
fi

mkdir -p "$APP_DIR/tools" "$APP_DIR/faces" "$APP_DIR/drizzle"
mkdir -p "$REPO_ROOT/server/tests/integration" "$REPO_ROOT/server/tests/e2e"

# sed substitute — no -i (portable between BSD and GNU); write via redirect.
sub() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|__APP_ID__|$APP_ID|g" \
    -e "s|__APP_ID_UNDERSCORE__|$APP_ID_UNDERSCORE|g" \
    -e "s|__APP_ID_SNAKE__|$APP_ID_SNAKE|g" \
    -e "s|__APP_NAME__|$APP_NAME|g" \
    -e "s|__APP_DESC__|$APP_DESC|g" \
    -e "s|__ICON__|$ICON|g" \
    -e "s|__PASCAL_NAME__|$PASCAL_NAME|g" \
    "$src" > "$dst"
}

sub "$SKILL_DIR/templates/design.md.tmpl"          "$APP_DIR/design.md"
sub "$SKILL_DIR/templates/manifest.ts.tmpl"        "$APP_DIR/manifest.ts"
sub "$SKILL_DIR/templates/index.ts.tmpl"           "$APP_DIR/index.ts"
sub "$SKILL_DIR/templates/schema.ts.tmpl"          "$APP_DIR/schema.ts"
sub "$SKILL_DIR/templates/integration.test.ts.tmpl" "$TEST_INT"
sub "$SKILL_DIR/templates/e2e.py.tmpl"             "$TEST_E2E"

cat <<EOF

scaffolded: apps/$APP_ID/
  design.md
  manifest.ts
  index.ts
  schema.ts
  tools/   (empty — author one file per tool in Phase 4)
  faces/   (empty — create one subdirectory per face in Phase 5 using the 'face' subcommand)
  drizzle/ (empty — populated by 'cd server && npm run db:generate -- $APP_ID' in Phase 3)

tests:
  server/tests/integration/$APP_ID.test.ts
  server/tests/e2e/test_${APP_ID_UNDERSCORE}.py

next:
  1. Fill in design.md (Phase 1). See references/design-doc-rubric.md.
     Think in faces — apps routinely have 2–4 (Today, History, Goals, Settings…), not one.
  2. Fill in schema.ts per the design. Run: cd server && npm run db:generate -- $APP_ID
  3. For each tool, author file + integration-test case. Run: npm test -- --run tests/integration/$APP_ID.test.ts
  4. For each face in your design doc, run:
        bash .claude/skills/build-moumantai-app/scripts/scaffold.sh face $APP_ID <face-id> "<Face Label>"
     e.g. bash ... face $APP_ID today "Today"
     Then fill the 4 generated files (resolve, parts, compact, expanded).
  5. Register ONLY the default face file from each face subdir in index.ts's faces: [...].
     The .expanded.ts siblings are auto-loaded by the framework.
  6. Fill the E2E test. Run: bash .claude/skills/build-moumantai-app/scripts/run-e2e.sh $APP_ID
  7. npx tsx .claude/skills/build-moumantai-app/scripts/validate.ts apps/$APP_ID
EOF
