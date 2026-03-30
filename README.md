# Codex Stream Deck Monitor

Lokale Windows-Integration fuer Elgato Stream Deck und Codex.

Die Loesung besteht aus zwei Teilen:

- `bridge/monitor-bridge.mjs`: lokale Status-Bridge mit 4 festen Slots
- `streamdeck-plugin/com.codex.stream-monitor.sdPlugin`: Stream-Deck-Plugin mit 4 Slot-Tasten, 2 Agenten-Leuchten fuer `Noah` und `Carmen` sowie 4 Noah-Monitor-Kacheln fuer Xetra- und US-Betrieb

Fuer Codex-Chats gibt es jetzt zusaetzlich einen expliziten Meldeweg:

- `scripts/codex-bridge-thread.ps1`: registriert den aktuellen Chat ueber `CODEX_THREAD_ID`, sendet Heartbeats und setzt `needs_input`, `done` oder `error`
- `plugins/codex-bridge-reporter`: repo-lokales Codex-Plugin mit Skill-Doku fuer denselben Ablauf

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

## Empfohlener Modus fuer Codex-Chats

Die Bridge arbeitet jetzt explizit thread-basiert:

- aktive Codex-Chats registrieren sich selbst ueber `CODEX_THREAD_ID`
- Heartbeats halten den Slot sauber auf `running`
- `needs_input`, `done` und `error` kommen direkt vom Chat statt aus Log-Raten
- Chat-Slots entstehen nur noch aus expliziter Registrierung, nicht mehr aus Codex-Logs

Chat registrieren und Heartbeat-Loop starten:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action register -Watch
```

Zwischenstand senden:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action progress -Detail "Analysiert Bridge"
```

Rueckfrage signalisieren:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action needs_input -Detail "Architektur offen"
```

Erfolgreich abschliessen:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action done -Detail "Fertig"
```

Fehler signalisieren:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action error -Detail "Build fehlgeschlagen" -ExitCode 1
```

Thread aus der Bridge entfernen:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action clear
```

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
   Verfuegbar sind `Codex Slot 1` bis `Codex Slot 4`, `Noah Light`, `Carmen Light`, `Noah Xetra Status`, `Noah Xetra Cycle`, `Noah US Status` und `Noah US Cycle`.

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
- freie Slots bleiben leer, solange du sie nicht bewusst belegst

## Agenten-Leuchten

`Noah` und `Carmen` nutzen jetzt dieses Modell:

- `online`: gruen
- `online` mit `--activity true`: gruen blinkend
- `attention`: gelb blinkend
- `offline`: rot
- Remote-Probes setzen standardmaessig nur noch Verfuegbarkeit. Fuer echtes "arbeitet gerade" nutze bewusst `heartbeat-agent --activity true` oder `POST /agents/:name` mit `"activity": true`.
- Falls du das alte, aus Remote-Dateiaktivitaet abgeleitete Blinken trotzdem willst, setze `CODEX_MONITOR_REMOTE_AGENT_ACTIVITY=1`.

Noah auf online:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent noah --status online --detail "Bereit"
```

Carmen mit Handlungsbedarf:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent carmen --status attention --detail "Rueckfrage offen"
```

Noah verarbeitet gerade Daten:

```powershell
node .\bridge\monitor-bridge.mjs heartbeat-agent --agent noah --activity true --detail "Verarbeitet Daten"
```

Agent auf offline:

```powershell
node .\bridge\monitor-bridge.mjs set-agent --agent noah --status offline --detail "Nicht verfuegbar"
```

## Noah-Monitor-Kacheln

Die vier Noah-Kacheln lesen ihre Daten ueber die lokale Bridge aus Noahs Companion- und Runtime-Daten:

- `Noah Xetra Status`: zeigt, ob der Xetra-Smoke laeuft und ob bereits Trades entstanden sind
- `Noah Xetra Cycle`: zeigt letzten Xetra-Zyklus, Cycle-Zaehler und Countdown bis zum naechsten Xetra-Zyklus
- `Noah US Status`: zeigt, ob Noah im US-Handel ist oder wie lange es noch bis zum Start dauert
- `Noah US Cycle`: zeigt letzten US-Zyklus, Trade-Counter und Countdown bis zum naechsten US-Zyklus

Die Bridge zieht dafuer Noah-Daten ueber den vorhandenen `ocvps`-SSH-Zugang. Fuer Xetra wird auf die Runtime-Registry zurueckgefallen, falls der deployte Companion-API-Prozess den Xetra-Endpunkt noch nicht ausliefert.

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
- `GET http://127.0.0.1:4567/threads`
- `POST http://127.0.0.1:4567/slots/:slot`
- `POST http://127.0.0.1:4567/agents/:name`
- `POST http://127.0.0.1:4567/threads/:threadId`
- `POST http://127.0.0.1:4567/threads/:threadId/heartbeat`

Beispiel:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/slots/3 -ContentType 'application/json' -Body '{"status":"needs_input","detail":"Bitte bestaetigen","label":"Task C"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/agents/noah -ContentType 'application/json' -Body '{"status":"online","detail":"Verarbeitet Daten","activity":true,"label":"Noah"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/threads/019d3dd0-ab21-7ee2-8de7-9286d91fd792 -ContentType 'application/json' -Body '{"status":"needs_input","detail":"Bitte entscheiden","label":"Stream Deck Integration"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4567/threads/019d3dd0-ab21-7ee2-8de7-9286d91fd792/heartbeat -ContentType 'application/json' -Body '{"status":"running","detail":"Implementiert","label":"Stream Deck Integration"}'
```

## Persistenz

Der letzte Zustand liegt hier:

```text
%APPDATA%\CodexStreamDeckMonitor\slots.json
```

```text
%APPDATA%\CodexStreamDeckMonitor\agents.json
```

```text
%APPDATA%\CodexStreamDeckMonitor\threads.json
```

Damit bleibt der Status auch nach einem Stream-Deck-Neustart erhalten.
