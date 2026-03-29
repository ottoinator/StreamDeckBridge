# Codex Stream Deck Monitor

Lokale Windows-Integration fuer Elgato Stream Deck und Codex.

Die Loesung besteht aus zwei Teilen:

- `bridge/monitor-bridge.mjs`: lokale Status-Bridge mit 4 festen Slots
- `streamdeck-plugin/com.codex.stream-monitor.sdPlugin`: Stream-Deck-Plugin mit 4 Slot-Tasten plus 3 Agenten-Leuchten fuer `Main`, `Noah`, `Carmen`

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

5. In der Stream-Deck-App die gewuenschten Tasten aus der Kategorie `Codex` auf ein Profil ziehen.
   Verfuegbar sind `Codex Slot 1` bis `Codex Slot 4` sowie `Main Light`, `Noah Light`, `Carmen Light`.

## Autostart ohne Shell-Fenster

Bridge einmal als Hintergrunddienst-Ersatz einrichten:

```powershell
npm run service:install
```

Das nutzt auf diesem Windows-Rechner einen versteckten Autostart-Launcher im Startup-Ordner, falls der Task Scheduler keine Registrierung erlaubt.

Manuell starten und stoppen:

```powershell
npm run service:start
npm run service:stop
```

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

Hinweis:

- bewusst gesetzte `running`-Slots zeigen auf dem Stream Deck die Laufzeit statt einer Uhrzeit
- zusaetzliche erkannte Codex-Prozesse koennen freie Slots automatisch als `Codex aktiv` belegen

## Agenten-Leuchten

`Main`, `Noah` und `Carmen` koennen als einfache Aktivitaetsleuchten genutzt werden.

Main auf aktiv:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent main --status active --detail "Arbeitet"
```

Noah auf inaktiv:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent noah --status idle --detail "Inaktiv"
```

Carmen auf Fehler:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent carmen --status error --detail "Stoerung"
```

## Ueber die Bridge starten

Beispiel fuer einen ueberwachten Prozess:

```powershell
node .\bridge\monitor-bridge.mjs start --slot 2 --label "Demo Build" --command "npm run build"
```

Der Prozess wird auf `running` gesetzt und beim Exit automatisch auf `done` oder `error`.

## HTTP-API

- `GET http://127.0.0.1:4567/health`
- `GET http://127.0.0.1:4567/state`
- `GET http://127.0.0.1:4567/slots`
- `GET http://127.0.0.1:4567/agents`
- `POST http://127.0.0.1:4567/slots/:slot`
- `POST http://127.0.0.1:4567/agents/:name`

Beispiel:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/slots/3 -ContentType 'application/json' -Body '{"status":"needs_input","detail":"Bitte bestaetigen","label":"Task C"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/agents/main -ContentType 'application/json' -Body '{"status":"active","detail":"Arbeitet","label":"Main"}'
```

## Persistenz

Der letzte Zustand liegt hier:

```text
%APPDATA%\CodexStreamDeckMonitor\slots.json
```

Damit bleibt der Status auch nach einem Stream-Deck-Neustart erhalten.
