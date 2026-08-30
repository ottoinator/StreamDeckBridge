#!/bin/sh
set -eu

TARGET="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.codex.stream-monitor.sdPlugin"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  rm -rf "$TARGET"
  echo "Plugin entfernt: $TARGET"
else
  echo "Plugin nicht installiert: $TARGET"
fi
