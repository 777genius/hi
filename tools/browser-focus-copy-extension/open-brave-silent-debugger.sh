#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-open}"
BRAVE_BUNDLE_ID="com.brave.Browser"
BRAVE_APP_NAME="Brave Browser"
BRAVE_FLAG="--silent-debugger-extension-api"

is_brave_running() {
  pgrep -x "Brave Browser" >/dev/null 2>&1
}

launch_brave() {
  open -na "$BRAVE_APP_NAME" --args "$BRAVE_FLAG"
}

if [[ "$MODE" != "open" && "$MODE" != "restart" ]]; then
  cat >&2 <<USAGE
Usage:
  $0 open     Open Brave with $BRAVE_FLAG if Brave is not already running.
  $0 restart  Quit Brave, then open it with $BRAVE_FLAG.
USAGE
  exit 64
fi

if [[ "$MODE" == "open" ]]; then
  if is_brave_running; then
    cat >&2 <<INFO
Brave is already running, so macOS will ignore new Chromium launch flags.

Run this instead if you want to restart Brave with the silent debugger flag:
  pnpm copy-helper:brave:restart-cdp
INFO
    exit 1
  fi

  launch_brave
  echo "Opened Brave with $BRAVE_FLAG"
  exit 0
fi

if is_brave_running; then
  osascript -e "tell application id \"$BRAVE_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in {1..80}; do
    if ! is_brave_running; then
      break
    fi
    sleep 0.1
  done
fi

if is_brave_running; then
  echo "Brave did not quit in time. Close it manually, then run again." >&2
  exit 1
fi

launch_brave
echo "Restarted Brave with $BRAVE_FLAG"
