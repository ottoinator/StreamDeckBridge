#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="com.codex.streamdeckbridge"

echo "StreamDeckBridge macOS Doctor"
echo "Root: $ROOT"
echo

printf 'node: '
if command -v node >/dev/null 2>&1; then node --version; elif [ -x /opt/homebrew/bin/node ]; then /opt/homebrew/bin/node --version; else echo "fehlt"; fi

printf 'npm: '
if command -v npm >/dev/null 2>&1; then npm --version; elif [ -x /opt/homebrew/bin/npm ]; then /opt/homebrew/bin/npm --version; else echo "fehlt"; fi

printf 'Stream Deck App: '
if [ -d "/Applications/Elgato Stream Deck.app" ] || [ -d "/Applications/Stream Deck.app" ]; then echo "gefunden"; else echo "nicht gefunden"; fi

printf 'Plugin-Verzeichnis: '
if [ -d "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins" ]; then echo "gefunden"; else echo "fehlt"; fi

printf 'Bridge Health: '
if curl -fsS "http://127.0.0.1:4567/health" >/dev/null 2>&1; then echo "ok"; else echo "nicht erreichbar"; fi

printf 'LaunchAgent: '
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "geladen"; else echo "nicht geladen"; fi
