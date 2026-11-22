#!/usr/bin/env bash
# Запускает собранное приложение в тестовом режиме: в окне появляется кнопка,
# которая по очереди озвучивает вопросы интервьюера через системный вывод.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Prefer this checkout's build; override with HACKINTERVIEW_APP for an installed bundle.
APP="${HACKINTERVIEW_APP:-$ROOT/src-tauri/target/release/bundle/macos/Telegram.app}"
PROFILE="${1:-fullstack}"

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found: $APP. Build it first (pnpm tauri build --bundles app)." >&2
  exit 1
fi

pkill -f "$APP/Contents/MacOS" 2>/dev/null || true
sleep 1
open -n --env INTERVIEW_TEST_MODE=1 --env INTERVIEW_TEST_PROFILE="$PROFILE" "$APP"
echo "Test interviewer mode started. Click the voice button in the app window to hear the next question."
