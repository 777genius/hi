#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$HELPER_DIR/dist/focus-copy-supervisor.pid"

if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && ps -p "$pid" >/dev/null 2>&1; then
    echo "Supervisor running pid=$pid"
  else
    echo "Shell supervisor pidfile exists but process is not running"
  fi
else
  echo "Shell supervisor is not installed"
fi

echo
echo "Helper processes (app-managed or shell-managed):"
ps -axo pid=,ppid=,stat=,command= \
  | grep "[/]tools/macos-focus-copy-helper/dist/Telegram.app/Contents/MacOS/Telegram" \
  | grep -v "bash -c" \
  || true

echo
echo "Accessibility check:"
"$SCRIPT_DIR/check-accessibility.sh" || true

echo
echo "Recent helper log:"
tail -n 30 "$HOME/Library/Logs/HackInterview/MacOSFocusCopyHelper.log" 2>/dev/null || true
