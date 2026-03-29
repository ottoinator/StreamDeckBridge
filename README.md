# Codex Stream Deck Monitor

Lokale Windows-Integration fuer Elgato Stream Deck und Codex.

Die Loesung besteht aus zwei Teilen:

- `bridge/monitor-bridge.mjs`: lokale Status-Bridge mit 4 festen Slots
- `streamdeck-plugin/com.codex.stream-monitor.sdPlugin`: Stream-Deck-Plugin mit 4 Slot-Tasten

## Statusmodell

Jeder Slot hat diese Felder:

- `slot`
- `label`
- `status`
- `detail`
- `updatedAt`
- `threadOrTaskId`
- `exitCode`

Gueltige Stati:

- `idle`
- `running`
- `needs_input`
- `error`
- `done`

## Schnellstart

1. Abhaengigkeiten installieren:

```powershell
npm install
```

2. Plugin bauen:

```powershell
npm run build
```

3. Plugin in Stream Deck installieren:

```powershell
npm run plugin:install
```

4. Bridge starten:

```powershell
npm run bridge
```

5. In der Stream-Deck-App vier Tasten aus der Kategorie `Codex` auf ein Profil ziehen.

## Slots manuell setzen

Slot auf `running`:

```powershell
node .\bridge\monitor-bridge.mjs set-status --slot 1 --status running --label "Task A" --detail "Implementiert"
```

Slot auf `needs_input`:

```powershell
node .\bridge\monitor-bridge.mjs set-status --slot 1 --status needs_input --detail "Rueckfrage offen"
```

Slot auf `done`:

```powershell
node .\bridge\monitor-bridge.mjs set-status --slot 1 --status done --detail "Alles erfolgreich"
```

Slot auf `error`:

```powershell
node .\bridge\monitor-bridge.mjs set-status --slot 1 --status error --detail "Build fehlgeschlagen" --exit-code 1
```

Slot zuruecksetzen:

```powershell
node .\bridge\monitor-bridge.mjs clear --slot 1
```

## Ueber die Bridge starten

Beispiel fuer einen ueberwachten Prozess:

```powershell
node .\bridge\monitor-bridge.mjs start --slot 2 --label "Demo Build" --command "npm run build"
```

Der Prozess wird auf `running` gesetzt und beim Exit automatisch auf `done` oder `error`.

## HTTP-API

- `GET http://127.0.0.1:4567/health`
- `GET http://127.0.0.1:4567/slots`
- `POST http://127.0.0.1:4567/slots/:slot`

Beispiel:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/slots/3 -ContentType 'application/json' -Body '{"status":"needs_input","detail":"Bitte bestaetigen","label":"Task C"}'
```

## Persistenz

Der letzte Zustand liegt hier:

```text
%APPDATA%\CodexStreamDeckMonitor\slots.json
```

Damit bleibt der Status auch nach einem Stream-Deck-Neustart erhalten.
