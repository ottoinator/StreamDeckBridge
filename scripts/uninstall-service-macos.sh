#!/bin/sh
set -eu

LABEL="com.codex.streamdeckbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

if [ "${1:-}" = "--stop-only" ]; then
  echo "Bridge LaunchAgent gestoppt."
  exit 0
fi

rm -f "$PLIST"
echo "Bridge LaunchAgent entfernt: $PLIST"
