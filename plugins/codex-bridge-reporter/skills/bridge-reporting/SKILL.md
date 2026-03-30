---
name: bridge-reporting
description: Register the current Codex chat with the local Stream Deck bridge, keep heartbeats alive, and publish short progress or attention states. Use when the user wants Codex work to be visible on the Stream Deck without relying on log parsing.
---

# Bridge Reporting

## Purpose

Use this skill when Codex work in this repository should appear reliably on the Stream Deck bridge.

The helper script uses `CODEX_THREAD_ID` automatically, so each Codex chat can report its own state explicitly.

## Commands

Run the shared helper from the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action register -Watch
```

Progress update:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action progress -Detail "Analysiert Bridge-API"
```

User input needed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action needs_input -Detail "Architekturentscheidung offen"
```

Successful finish:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action done -Detail "Aenderung umgesetzt"
```

Failure:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action error -Detail "Build fehlgeschlagen" -ExitCode 1
```

Clear the thread from the bridge:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-bridge-thread.ps1 -Action clear
```

## Behavior

1. At the beginning of substantial work, register the chat with `-Action register -Watch`.
2. Keep details short and glanceable, usually 2-5 words.
3. After meaningful milestones, send `progress` with a concrete detail.
4. If the user must decide something, send `needs_input` before asking.
5. End with `done` or `error`.

## Notes

- The script talks to `http://127.0.0.1:4567` by default.
- Override the bridge URL with `CODEX_MONITOR_BASE_URL` if needed.
- If the bridge is offline, mention that briefly to the user and continue the main task unless the bridge itself is the task.
