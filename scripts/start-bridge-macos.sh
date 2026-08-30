#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

find_node() {
  if [ -n "${NODE:-}" ] && [ -x "$NODE" ]; then
    printf '%s\n' "$NODE"
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v node
}

NODE_BIN=$(find_node)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export CODEX_MONITOR_HOST="${CODEX_MONITOR_HOST:-127.0.0.1}"
export CODEX_MONITOR_PORT="${CODEX_MONITOR_PORT:-4567}"
export CODEX_MONITOR_DATA_DIR="${CODEX_MONITOR_DATA_DIR:-$HOME/Library/Application Support/CodexStreamDeckMonitor}"
export CODEX_MONITOR_NOAH_MONITOR_BASE_URL="${CODEX_MONITOR_NOAH_MONITOR_BASE_URL:-http://100.98.171.9:8765}"

mkdir -p "$CODEX_MONITOR_DATA_DIR" "$ROOT/logs"
cd "$ROOT"
exec "$NODE_BIN" "$ROOT/bridge/monitor-bridge.mjs" serve
