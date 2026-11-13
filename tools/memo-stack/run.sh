#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"

resolve_memo_stack_dir() {
  if [ -n "${MEMO_STACK_DIR:-}" ]; then
    printf '%s\n' "$MEMO_STACK_DIR"
    return
  fi

  if [ -n "${MEMORY_PLATFORM_DIR:-}" ]; then
    printf '%s\n' "$MEMORY_PLATFORM_DIR"
    return
  fi

  for candidate in \
    "../ai/memo-stack" \
    "../memo-stack" \
    "$HOME/dev/projects/ai/memo-stack" \
    "$HOME/dev/projects/memo-stack" \
    "../ai/memory-platform" \
    "../memory-platform" \
    "$HOME/dev/projects/ai/memory-platform" \
    "$HOME/dev/projects/memory-platform"
  do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' ""
}

ensure_memory_dir() {
  memory_dir="$(resolve_memo_stack_dir)"
  if [ -z "$memory_dir" ] || [ ! -d "$memory_dir" ]; then
    echo "Memo Stack repo not found."
    echo "Clone https://github.com/777genius/memo-stack to ~/dev/projects/ai/memo-stack or set MEMO_STACK_DIR=/path/to/memo-stack."
    echo "Compatibility: MEMO_STACK_DIR and old memory-platform checkout paths still work."
    exit 1
  fi
  cd "$memory_dir"
}

ensure_venv() {
  if [ ! -x ".venv/bin/python" ]; then
    echo "Memo Stack venv is missing."
    echo "Run: cd $(pwd) && python3 -m venv .venv && .venv/bin/python -m pip install -e '.[dev,qdrant,openai,graphiti,mcp]'"
    exit 1
  fi
}

ensure_memory_dir

export MEMORY_DEFAULT_SPACE_SLUG="${MEMORY_DEFAULT_SPACE_SLUG:-hackinterview}"
export MEMORY_LEGACY_HACKINTERVIEW_ENABLED="${MEMORY_LEGACY_HACKINTERVIEW_ENABLED:-true}"
export MEMORY_SMOKE_SPACE="${MEMORY_SMOKE_SPACE:-hackinterview}"
export MEMORY_MCP_DEFAULT_SPACE_SLUG="${MEMORY_MCP_DEFAULT_SPACE_SLUG:-hackinterview}"

case "$command_name" in
  up)
    make memory-up-full-deps
    ;;
  server)
    ensure_venv
    MEMORY_AUTO_CREATE_SCHEMA=true MEMORY_SERVICE_TOKEN="${MEMORY_SERVICE_TOKEN:-local-dev-token}" .venv/bin/python -m memory_server.main
    ;;
  stack)
    make memory-stack-up-lite
    ;;
  full-stack)
    make memory-stack-up-full
    ;;
  smoke)
    ensure_venv
    make memory-smoke
    ;;
  mcp-smoke)
    ensure_venv
    make memory-mcp-smoke
    ;;
  clean-full-smoke)
    ensure_venv
    make memory-clean-full-smoke
    ;;
  *)
    echo "Usage: tools/memo-stack/run.sh up|server|stack|full-stack|smoke|mcp-smoke|clean-full-smoke"
    exit 2
    ;;
esac
