#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LABEL="com.codex.streamdeckbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs" "$HOME/Library/Application Support/CodexStreamDeckMonitor"

if [ "${1:-}" != "--start-only" ]; then
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/start-bridge-macos.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CODEX_MONITOR_HOST</key><string>${CODEX_MONITOR_HOST:-127.0.0.1}</string>
    <key>CODEX_MONITOR_PORT</key><string>${CODEX_MONITOR_PORT:-4567}</string>
    <key>CODEX_MONITOR_DATA_DIR</key><string>${CODEX_MONITOR_DATA_DIR:-$HOME/Library/Application Support/CodexStreamDeckMonitor}</string>
    <key>CODEX_MONITOR_NOAH_MONITOR_BASE_URL</key><string>${CODEX_MONITOR_NOAH_MONITOR_BASE_URL:-http://100.98.171.9:8765}</string>
  </dict>
  <key>StandardOutPath</key><string>$ROOT/logs/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/bridge.err.log</string>
</dict>
</plist>
EOF
fi

if [ ! -f "$PLIST" ]; then
  echo "LaunchAgent fehlt: $PLIST" >&2
  echo "Fuehre zuerst npm run service:install aus." >&2
  exit 1
fi

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Bridge LaunchAgent aktiv: $PLIST"
