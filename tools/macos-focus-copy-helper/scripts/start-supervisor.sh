#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$HELPER_DIR/dist/Telegram.app"
EXECUTABLE="$APP_DIR/Contents/MacOS/Telegram"
PIDFILE="$HELPER_DIR/dist/focus-copy-supervisor.pid"
LABEL="ai.hackinterview.focus-copy-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/HackInterview"
SUPERVISOR_LOG="$LOG_DIR/MacOSFocusCopyHelper.supervisor.log"
UID_VALUE="$(id -u)"

"$SCRIPT_DIR/build-app.sh"
mkdir -p "$LOG_DIR" "$HELPER_DIR/dist"

launchctl bootout "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [[ -f "$PIDFILE" ]]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]]; then
    kill "$old_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PIDFILE"
fi

pkill -f "/tools/macos-focus-copy-helper/dist/[T]elegram.app/Contents/MacOS/Telegram" >/dev/null 2>&1 || true

nohup bash -c '
  set -u
  executable="$1"
  log_file="$2"
  while true; do
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] supervisor starting helper: $executable" >> "$log_file"
    "$executable"
    exit_code=$?
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] helper exited with code $exit_code; restarting in 1s" >> "$log_file"
    sleep 1
  done
' _ "$EXECUTABLE" "$SUPERVISOR_LOG" >/dev/null 2>&1 &

echo "$!" > "$PIDFILE"
echo "Started focus copy supervisor pid=$!"
echo "Helper executable: $EXECUTABLE"
sleep 1
"$SCRIPT_DIR/status-supervisor.sh"
