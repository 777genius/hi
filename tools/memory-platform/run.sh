#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"

resolve_memory_platform_dir() {
  if [ -n "${MEMORY_PLATFORM_DIR:-}" ]; then
    printf '%s\n' "$MEMORY_PLATFORM_DIR"
    return
  fi

  for candidate in \
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
  memory_dir="$(resolve_memory_platform_dir)"
  if [ -z "$memory_dir" ] || [ ! -d "$memory_dir" ]; then
    echo "Memory Platform repo not found."
    echo "Clone https://github.com/777genius/memory-platform to ~/dev/projects/ai/memory-platform or set MEMORY_PLATFORM_DIR=/path/to/memory-platform."
    exit 1
  fi
  cd "$memory_dir"
}

ensure_venv() {
  if [ ! -x ".venv/bin/python" ]; then
    echo "Memory Platform venv is missing."
    echo "Run: cd $(pwd) && python3 -m venv .venv && .venv/bin/python -m pip install -e '.[dev,qdrant,openai,graphiti,mcp]'"
    exit 1
  fi
}

ensure_memory_dir

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
    echo "Usage: tools/memory-platform/run.sh up|server|stack|full-stack|smoke|mcp-smoke|clean-full-smoke"
    exit 2
    ;;
esac
