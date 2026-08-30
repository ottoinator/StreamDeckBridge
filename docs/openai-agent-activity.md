# Agenten-Aktivitaet fuer Noah und Carmen

Ziel: Die Leuchten fuer `Noah` und `Carmen` sollen nicht mehr nur "Host lebt" zeigen, sondern echte Agenten-Aktivitaet.

## Architektur

Die lokale Bridge kann fuer jeden Agenten optional einen kleinen HTTP-JSON-Endpunkt statt des bisherigen SSH-Probes nutzen:

- `CODEX_MONITOR_NOAH_STATUS_URL`
- `CODEX_MONITOR_CARMEN_STATUS_URL`

Wenn einer dieser Werte gesetzt ist, liest die Bridge den JSON-Status direkt per HTTP. Carmen hat auf macOS zusaetzlich einen lokalen Default: Die Bridge liest `openai_activity.py` direkt aus dem Docker-Container `carmen-runtime`. Das alte SSH-Fallback bleibt nur fuer Legacy-/Remote-Betrieb erhalten und wird fuer Carmen erst genutzt, wenn `CODEX_MONITOR_CARMEN_SSH_HOST` explizit gesetzt ist.

Wichtig:

- Carmen zeigt das aktuelle OpenAI-Fenster: `OpenAI <tokens> Tok/<minuten>m`.
- Historische Gesamtsummen wie `totalTokens` bleiben Diagnosewerte und werden nicht als Haupttext angezeigt.
- Noah ist Python-only und zeigt deshalb `Runtime <Markt> <Modus>` statt OpenAI-Tokens.
- Noah blinkt, wenn sich Zykluszeit, Marktstatus, PnL oder Trade-Zaehler aendern.
- Das alte Dateisystem-basierte Remote-Blinken bleibt weiterhin nur ueber `CODEX_MONITOR_REMOTE_AGENT_ACTIVITY=1` aktiv.

## Minimales JSON-Format

Der Endpunkt darf sehr klein sein. Dieses Format reicht schon:

```json
{
  "status": "online",
  "detail": "OpenAI 4.8k Tok/5m",
  "recentActivity": true,
  "activityMetric": "tokens:184220"
}
```

Empfohlen ist dieses etwas reichere Format, weil die Bridge daraus bei Bedarf selbst ein Detail ableiten kann:

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

Die Bridge versteht aktuell unter anderem diese Felder:

- `status`
- `detail`
- `recentActivity`
- `activityMetric`
- `openai.totalTokens`
- `openai.windowTokens`
- `openai.windowMinutes`
- `openai.lastActivityAt`
- `usage.total_tokens`
- `tokens.total`

## Empfohlene Strategie

### Noah Remote/VPS

Ohne expliziten SSH-Override nutzt die Bridge fuer Noah den Companion-Endpunkt:

```sh
http://100.98.171.9:8765/api/v1/status/openai-activity
```

Die Basis kann ueber `CODEX_MONITOR_NOAH_MONITOR_BASE_URL` geaendert werden.

1. Im Agentenprozess alle OpenAI-Responses mitzaehlen.
2. Die Summen in eine kleine lokale JSON-Datei schreiben, zum Beispiel:

```json
{
  "totalTokens": 184220,
  "windowTokens": 4820,
  "windowMinutes": 5,
  "lastActivityAt": "2026-03-30T10:55:12Z"
}
```

3. Einen sehr schlanken lokalen Endpoint auf dem VPS bereitstellen, der genau diese Daten als JSON ausliefert.
4. Die Stream-Deck-Bridge auf diesen Endpoint zeigen lassen.

Vorteil:

- keine SSH-Parsing-Logik fuer Tokenzaehler
- wenig Last
- sauberer Vertrag zwischen Agent und Bridge
- spaeter leicht auf weitere Agenten erweiterbar

### Carmen lokal auf macOS

Carmen laeuft lokal im Docker-Container `carmen-runtime`. Ohne weitere Konfiguration nutzt die macOS-Bridge diesen Pull:

```sh
docker exec carmen-runtime sh -lc 'cd /root/.openclaw/workspace && python3 integrations/whatsapp/openai_activity.py'
```

Falls der Containername oder Pfad abweicht:

```sh
export CODEX_MONITOR_CARMEN_LOCAL_STATUS_COMMAND="docker exec <container> sh -lc 'cd /root/.openclaw/workspace && python3 integrations/whatsapp/openai_activity.py'"
```

## Beispielkonfiguration

```powershell
$env:CODEX_MONITOR_NOAH_STATUS_URL = "http://ocvps:8765/api/v1/status/openai-activity"
$env:CODEX_MONITOR_NOAH_STATUS_BEARER_TOKEN = "NOAH_COMPANION_API_TOKEN"
```

Optional koennen statt Bearer-Token auch ein einzelner eigener Header-Name und Header-Wert gesetzt werden:

```powershell
$env:CODEX_MONITOR_NOAH_STATUS_HEADER_NAME = "X-Bridge-Key"
$env:CODEX_MONITOR_NOAH_STATUS_HEADER_VALUE = "supersecret"
```

## Referenz-Endpoint

Im Repo liegt eine kleine Referenz unter:

- `scripts/openai-activity-endpoint.py`

Die Idee ist bewusst simpel:

- liest eine JSON-Datei mit OpenAI-Aktivitaet
- serviert sie lokal per HTTP
- keine Extra-Dependencies

## Jetzt konkret umgesetzt

Noah:

- bestehende Companion-API erweitert
- neuer geschuetzter Endpoint:
  - `GET /api/v1/status/openai-activity`
- `GET /api/v1/status/current` enthaelt jetzt auch einen `openai`-Block

Carmen:

- lokale macOS-Bridge liest den Docker-Container `carmen-runtime`
- `integrations/whatsapp/openai_activity.py` liefert direkt das JSON fuer die Kachel
- Remote/VPS-Konfiguration ist nur noch Legacy oder explizite Override-Konfiguration

Beide Wege lesen die Aktivitaet direkt aus OpenClaw-Main-Session-JSONL und failen bei fehlendem Zugriff sauber auf `0` Aktivitaet zu, statt den Statusdienst zu brechen.
