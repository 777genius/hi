#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$HELPER_DIR/dist/focus-copy-supervisor.pid"
LABEL="ai.hackinterview.focus-copy-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PIDFILE"
fi

pkill -f "/tools/macos-focus-copy-helper/dist/[T]elegram.app/Contents/MacOS/Telegram" >/dev/null 2>&1 || true

echo "Stopped focus copy supervisor and helper"
