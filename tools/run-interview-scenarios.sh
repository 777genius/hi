#!/usr/bin/env bash
# Последовательный прогон длинных аудио-интервью (по одному сценарию из e2e-tests/scenarios).
# Использование: tools/run-interview-scenarios.sh [минуты на сценарий] сценарий1 сценарий2 ...
# Перед каждым сценарием приложение перезапускается из src-tauri/target/release/bundle/macos/Telegram.app.
set -uo pipefail
cd "$(dirname "$0")/.."
MINUTES="${1:-60}"; shift || true
SCENARIOS=("$@")
LLM_ENV="$HOME/.local/share/hackinterview-sub2api/hackinterview-llm.env"
APP="src-tauri/target/release/bundle/macos/Telegram.app"
LOG_DIR=".e2e-artifacts/scenario-runs"
mkdir -p "$LOG_DIR"

start_app() {
  pkill -f "release/bundle/macos/Telegram.app/Contents/MacOS" 2>/dev/null; sleep 2
  set -a; . "$LLM_ENV"; set +a
  open -n --env LLM_PROVIDER="$LLM_PROVIDER" --env OPENAI_BASE_URL="$OPENAI_BASE_URL" --env OPENAI_API_KEY="$OPENAI_API_KEY" \
    --env OPENAI_RESPONSES_MODEL="$OPENAI_RESPONSES_MODEL" --env OPENAI_RESPONSES_REASONING_EFFORT="$OPENAI_RESPONSES_REASONING_EFFORT" \
    --env INTERVIEW_MEMORY_FORCE_LOCAL_ONLY=true --env INTERVIEW_TEST_MODE=1 "$APP"
  for _ in $(seq 1 60); do
    sleep 2
    TOKEN=$(python3 -I -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/HackInterview/companion_bridge.json')))['companionAccessToken'])" 2>/dev/null)
    curl -fs -m 3 http://127.0.0.1:43821/api/health >/dev/null 2>&1 && return 0
  done
  return 1
}

for name in "${SCENARIOS[@]}"; do
  echo "=== $(date +%T) scenario $name (${MINUTES} min)" | tee -a "$LOG_DIR/driver.log"
  if ! start_app; then echo "app did not start for $name" | tee -a "$LOG_DIR/driver.log"; continue; fi
  sleep 20 # прогрев моделей
  node e2e-tests/companion-ua-interview-audio.mjs --scenario "e2e-tests/scenarios/$name.json" --duration-min "$MINUTES" --turns "${TURNS:-0}" \
    > "$LOG_DIR/$name.log" 2>&1
  node_status=$?
  echo "=== $(date +%T) $name exit=$node_status $(grep -E 'SUMMARY|JUDGE' "$LOG_DIR/$name.log" | tail -2 | cut -c1-400)" | tee -a "$LOG_DIR/driver.log"
done
