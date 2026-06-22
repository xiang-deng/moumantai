#!/bin/bash
# Run E2E instrumented tests on an Android emulator AVD.
#
# Usage: ./run-e2e-tests.sh
#
# Environment:
#   ANDROID_HOME  — Android SDK path (set in .mise.local.toml or your shell). Required.
#   AVD_NAME      — name of the AVD to boot (default: Small_Cover_Screen). Create
#                   one via Android Studio's Device Manager if not present.
set -e

if [ -z "${ANDROID_HOME:-}" ]; then
    echo "ERROR: ANDROID_HOME is not set. Configure it in .mise.local.toml at the repo root."
    exit 1
fi
SDK_DIR="$ANDROID_HOME"
# Use the .exe suffix on Windows shells; falls back to the unsuffixed binary elsewhere.
EMULATOR="$SDK_DIR/emulator/emulator"
[ -f "${EMULATOR}.exe" ] && EMULATOR="${EMULATOR}.exe"
ADB="$SDK_DIR/platform-tools/adb"
[ -f "${ADB}.exe" ] && ADB="${ADB}.exe"
AVD_NAME="${AVD_NAME:-Small_Cover_Screen}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Moumantai E2E Instrumented Tests ==="
echo "AVD: $AVD_NAME"
echo "SDK: $SDK_DIR"
echo ""

# Check emulator binary
if [ ! -f "$EMULATOR" ]; then
    echo "ERROR: Emulator not found at $EMULATOR"
    echo "Set ANDROID_HOME to your SDK path."
    exit 1
fi

# Check AVD exists
if ! "$EMULATOR" -list-avds 2>/dev/null | grep -q "$AVD_NAME"; then
    echo "ERROR: AVD '$AVD_NAME' not found."
    echo "Available AVDs:"
    "$EMULATOR" -list-avds
    exit 1
fi

echo "Starting emulator: $AVD_NAME"
"$EMULATOR" -avd "$AVD_NAME" -no-window -no-audio -gpu swiftshader_indirect &
EMULATOR_PID=$!

echo "Waiting for device to boot..."
"$ADB" wait-for-device
"$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
echo "Device ready."
echo ""

echo "Running instrumented tests..."
cd "$SCRIPT_DIR"
./gradlew connectedAndroidTest
TEST_EXIT=$?

echo ""
echo "Stopping emulator..."
"$ADB" emu kill
wait $EMULATOR_PID 2>/dev/null || true

if [ $TEST_EXIT -eq 0 ]; then
    echo "All tests passed."
else
    echo "Some tests failed (exit code: $TEST_EXIT)."
fi

exit $TEST_EXIT
