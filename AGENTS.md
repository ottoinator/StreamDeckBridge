# Project Bridge Reporting

In this repository, Codex should report active chat state to the local Stream Deck bridge whenever the work is substantial.

## Required Bridge Flow

1. At the start of substantial work, run:

```bash
node scripts/codex-bridge-thread.mjs register --watch
```

2. After meaningful milestones, send a short progress update:

```bash
node scripts/codex-bridge-thread.mjs progress --detail "Kurzer Zwischenstand"
```

3. If user input is required, signal it before asking:

```bash
node scripts/codex-bridge-thread.mjs needs_input --detail "Entscheidung offen"
```

4. On completion or failure, close the reported state:

```bash
node scripts/codex-bridge-thread.mjs done --detail "Erfolgreich beendet"
```

```bash
node scripts/codex-bridge-thread.mjs error --detail "Fehler" --exit-code 1
```

## Notes

- The macOS helper script uses `CODEX_THREAD_ID` automatically. Windows can still use `scripts/codex-bridge-thread.ps1`.
- Keep bridge details glanceable and short.
- If the bridge is unavailable, continue the main task and mention the bridge issue briefly.
