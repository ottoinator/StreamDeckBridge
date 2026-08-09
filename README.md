# Codex Stream Deck Monitor

Lokale macOS-Integration fuer Elgato Stream Deck und Codex. Die fruehere Windows-Integration bleibt als Legacy-Pfad erhalten.

Die Loesung besteht aus zwei Teilen:

- `bridge/monitor-bridge.mjs`: lokale Status-Bridge mit 4 festen Slots
- `streamdeck-plugin/com.codex.stream-monitor.sdPlugin`: fokussiertes Stream-Deck-Plugin mit genau drei Kacheln fuer US Runtime, MLB Elo v2 und Weather Public

Fuer Codex-Chats gibt es einen expliziten Meldeweg:

- `scripts/codex-bridge-thread.mjs`: registriert den aktuellen Chat ueber `CODEX_THREAD_ID`, sendet Heartbeats und setzt `needs_input`, `done` oder `error`
- `scripts/codex-bridge-thread.ps1`: Legacy-Variante fuer Windows
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
- der Watcher erkennt einen abgeschlossenen Turn ueber den lokalen Codex-Session-Log und setzt den Chat danach automatisch auf `done`
- automatisches Idle-`done` ist optional und nur aktiv, wenn `CODEX_MONITOR_THREAD_IDLE_DONE_SECONDS` gesetzt ist

Chat registrieren und Heartbeat-Loop starten:

```bash
node scripts/codex-bridge-thread.mjs register --watch
```

Zwischenstand senden:

```bash
node scripts/codex-bridge-thread.mjs progress --detail "Analysiert Bridge"
```

Rueckfrage signalisieren:

```bash
node scripts/codex-bridge-thread.mjs needs_input --detail "Architektur offen"
```

Erfolgreich abschliessen:

```bash
node scripts/codex-bridge-thread.mjs done --detail "Fertig"
```

Fehler signalisieren:

```bash
node scripts/codex-bridge-thread.mjs error --detail "Build fehlgeschlagen" --exit-code 1
```

Thread aus der Bridge entfernen:

```bash
node scripts/codex-bridge-thread.mjs clear
```

## Schnellstart

1. Abhaengigkeiten installieren:

```bash
npm install
```

2. Plugin bauen:

```bash
npm run build
```

3. Plugin in Stream Deck installieren:

```bash
npm run plugin:install
```

4. Bridge starten:

```bash
npm run bridge
```

5. In der Stream-Deck-App die gewuenschten Tasten aus der Kategorie `Codex Monitor` auf ein Profil ziehen.
   Verfuegbar sind ausschliesslich `US Runtime`, `MLB Elo v2` und `Weather Public`.

## Autostart auf macOS

Bridge einmal als Hintergrunddienst-Ersatz einrichten:

```bash
npm run service:install
```

Die Installation legt einen LaunchAgent unter `~/Library/LaunchAgents/com.codex.streamdeckbridge.plist` an und startet die Bridge im Benutzerkontext. Das passt zur Stream-Deck-App, die ebenfalls als Benutzer-App laeuft.

Logs liegen unter:

```text
logs/bridge.out.log
logs/bridge.err.log
```

Manuell starten und stoppen:

```bash
npm run service:start
npm run service:stop
```

Die eigentliche Bridge laeuft dabei ueber:

```text
scripts/start-bridge-macos.sh
```

Diagnose:

```bash
npm run doctor
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
- Frische Push-Signale haben Vorrang. Wenn kein aktueller Push mehr anliegt, faellt die Bridge automatisch auf die Remote-Probe zurueck statt nur gelb zu blinken.
- Remote-Probes setzen standardmaessig nur noch Verfuegbarkeit. Fuer echtes "arbeitet gerade" nutze bewusst `heartbeat-agent --activity true` oder `POST /agents/:name` mit `"activity": true`.
- Fuer explizite OpenAI- oder Aktivitaetsdaten aus einem Remote-JSON-Endpunkt kann die Bridge jetzt direkt blinken, ohne das alte Dateisystem-Fallback zu aktivieren.
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

### Tokenbasierte Agenten-Aktivitaet

Fuer Noah kann die Bridge optional statt SSH einen schlanken HTTP-JSON-Endpunkt auf dem VPS abfragen. Carmen laeuft auf macOS standardmaessig gegen den lokalen Docker-Container `carmen-runtime` und liest dort `integrations/whatsapp/openai_activity.py` per `docker exec`:

- `CODEX_MONITOR_NOAH_STATUS_URL`
- `CODEX_MONITOR_CARMEN_STATUS_URL`
- `CODEX_MONITOR_CARMEN_LOCAL_STATUS_COMMAND`

Optional:

- `CODEX_MONITOR_<AGENT>_STATUS_BEARER_TOKEN`
- `CODEX_MONITOR_<AGENT>_STATUS_HEADER_NAME`
- `CODEX_MONITOR_<AGENT>_STATUS_HEADER_VALUE`
- `CODEX_MONITOR_<AGENT>_STATUS_TIMEOUT_MS`

Kleinstes sinnvolles JSON:

```json
{
  "status": "online",
  "detail": "OpenAI 4.8k Tok/5m",
  "recentActivity": true,
  "activityMetric": "tokens:184220"
}
```

Alternativ reicht auch:

```json
{
  "status": "online",
  "openai": {
    "totalTokens": 184220,
    "windowTokens": 4820,
    "windowMinutes": 5,
    "lastActivityAt": "2026-03-30T10:55:12Z"
  }
}
```

Die Carmen-Kachel zeigt bewusst das aktuelle Fenster als `OpenAI <tokens> Tok/<minuten>m`. Historische Gesamtsummen werden nicht mehr als Haupttext angezeigt, damit `3.6M Tok ges.` nicht wie aktueller Verbrauch wirkt. Die Leuchte blinkt nur bei Aktivitaet im aktuellen Fenster.

Noah ist eine Python-only-Runtime. Die Noah-Agentenleuchte nutzt deshalb keine OpenAI-Tokens, sondern den vorhandenen Noah-Monitor: Zykluszeit, Marktstatus, PnL und Trade-Zaehler bilden eine Runtime-Metric. Die Kachel zeigt `Runtime <Markt> <Modus>` und blinkt, wenn sich diese Runtime-Metric aendert.

In den zugehoerigen Agenten-Repos sind jetzt bereits konkrete Endpunkte vorgesehen:

- Noah:
  - `http://<host>:8765/api/v1/status/openai-activity`
  - Auth: `NOAH_COMPANION_API_TOKEN`
  - macOS-Default: `CODEX_MONITOR_NOAH_MONITOR_BASE_URL` oder `http://100.98.171.9:8765`
- Carmen:
  - macOS-Default: `docker exec carmen-runtime sh -lc 'cd /root/.openclaw/workspace && python3 integrations/whatsapp/openai_activity.py'`
  - Legacy/Remote nur explizit ueber `CODEX_MONITOR_CARMEN_STATUS_URL` oder `CODEX_MONITOR_CARMEN_SSH_HOST`

Eine kleine Referenz fuer so einen VPS-Endpunkt liegt hier:

```text
scripts/openai-activity-endpoint.py
```

Mehr Details und die empfohlene Architektur:

```text
docs/openai-agent-activity.md
```

## Operator-Kacheln

Das Plugin stellt genau drei read-only Kacheln bereit:

- `US Runtime`: liest den oeffentlichen Companion-Status und akzeptiert ausschliesslich den kanonischen Markt `us`.
- `MLB Elo v2`: liest die lokalen, paper-only Continuity-, Capture- und Paper-Projektionen der v2-Confirmatory-Lane.
- `Weather Public`: zeigt den Status der oeffentlichen AWC-METAR-/NWS-Lane und markiert stale, blocked oder fehlende Statusdaten fail-closed.

Es gibt keine Markt-Auswahl, keine Umschaltaktion und keine aggregierten PnL-/Trade-Kacheln mehr. MLB Elo v2 und Weather sind reine Beobachtungsflaechen ohne Order-, Wallet- oder Promotion-Autoritaet.

Optionale Pfad-Overrides fuer die Bridge:

```text
CODEX_MONITOR_MLB_ELO_V2_ROOT
CODEX_MONITOR_WEATHER_PUBLIC_STATUS_PATH
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
