#!/bin/sh
set -eu

SCRIPT_PATTERN="bridge/monitor-bridge.mjs"
PIDS=$(pgrep -f "$SCRIPT_PATTERN" || true)

if [ -z "$PIDS" ]; then
  echo "Keine laufende Codex Monitor Bridge gefunden."
  exit 0
fi

echo "$PIDS" | while IFS= read -r pid; do
  [ "$pid" = "$$" ] && continue
  kill "$pid" >/dev/null 2>&1 || true
done

echo "Codex Monitor Bridge gestoppt."
