#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE="$ROOT/streamdeck-plugin/com.codex.stream-monitor.sdPlugin"
TARGET_ROOT="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
TARGET="$TARGET_ROOT/com.codex.stream-monitor.sdPlugin"

if [ ! -d "$SOURCE" ]; then
  echo "Plugin-Quelle nicht gefunden: $SOURCE" >&2
  exit 1
fi

cd "$ROOT"
if [ -x "$ROOT/node_modules/.bin/streamdeck" ]; then
  if "$ROOT/node_modules/.bin/streamdeck" link "$SOURCE"; then
    echo "Plugin per streamdeck link installiert: $SOURCE"
    exit 0
  fi
fi

mkdir -p "$TARGET_ROOT"
rm -rf "$TARGET"
cp -R "$SOURCE" "$TARGET"
echo "Plugin kopiert nach: $TARGET"
