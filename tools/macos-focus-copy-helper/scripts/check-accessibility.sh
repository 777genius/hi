#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$HELPER_DIR/dist/Telegram.app"
EXECUTABLE="$APP_DIR/Contents/MacOS/Telegram"

if [[ ! -x "$EXECUTABLE" ]]; then
  "$SCRIPT_DIR/build-app.sh"
fi

"$EXECUTABLE" --check-accessibility
