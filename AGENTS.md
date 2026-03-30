# Project Bridge Reporting

In this repository, Codex should report active chat state to the local Stream Deck bridge whenever the work is substantial.

## Required Bridge Flow

1. At the start of substantial work, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action register -Watch
```

2. After meaningful milestones, send a short progress update:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action progress -Detail "Kurzer Zwischenstand"
```

3. If user input is required, signal it before asking:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action needs_input -Detail "Entscheidung offen"
```

4. On completion or failure, close the reported state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action done -Detail "Erfolgreich beendet"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action error -Detail "Fehler" -ExitCode 1
```

## Notes

- The helper script uses `CODEX_THREAD_ID` automatically.
- Keep bridge details glanceable and short.
- If the bridge is unavailable, continue the main task and mention the bridge issue briefly.
