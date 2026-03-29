import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.CODEX_MONITOR_PORT || 4567);
const HOST = process.env.CODEX_MONITOR_HOST || "127.0.0.1";
const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodexStreamDeckMonitor");
const DATA_FILE = path.join(DATA_DIR, "slots.json");
const HEARTBEAT_TIMEOUT_MS = 30_000;
const VALID_STATUSES = new Set(["idle", "running", "needs_input", "error", "done"]);

function nowIso() {
  return new Date().toISOString();
}

function slotLabel(slot) {
  return `Codex ${slot}`;
}

function createDefaultSlot(slot) {
  return {
    slot,
    label: slotLabel(slot),
    status: "idle",
    detail: "Bereit",
    updatedAt: nowIso(),
    threadOrTaskId: "",
    exitCode: null,
    pid: null,
    heartbeatAt: null
  };
}

async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DATA_FILE, "utf8");
  } catch {
    await writeFile(
      DATA_FILE,
      `${JSON.stringify(Array.from({ length: 4 }, (_, index) => createDefaultSlot(index + 1)), null, 2)}\n`,
      "utf8"
    );
  }
}

async function readSlots() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const defaults = Array.from({ length: 4 }, (_, index) => createDefaultSlot(index + 1));
    await writeSlots(defaults);
    return defaults;
  }
  const slots = Array.isArray(parsed) ? parsed : parsed?.slots;
  if (!Array.isArray(slots) || slots.length !== 4) {
    const defaults = Array.from({ length: 4 }, (_, index) => createDefaultSlot(index + 1));
    await writeSlots(defaults);
    return defaults;
  }
  return slots.map((slot, index) => ({
    ...createDefaultSlot(index + 1),
    ...slot,
    slot: index + 1
  }));
}

async function writeSlots(slots) {
  await ensureDataFile();
  await writeFile(DATA_FILE, `${JSON.stringify(slots, null, 2)}\n`, "utf8");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    throw new Error("slot must be between 1 and 4");
  }
  return slot;
}

function normalizeStatus(value) {
  if (!VALID_STATUSES.has(value)) {
    throw new Error(`status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`);
  }
  return value;
}

function applyPatch(slot, patch) {
  const next = { ...slot };
  if (patch.label !== undefined) next.label = String(patch.label || slotLabel(slot.slot)).trim() || slotLabel(slot.slot);
  if (patch.status !== undefined) next.status = normalizeStatus(String(patch.status));
  if (patch.detail !== undefined) next.detail = String(patch.detail || "").trim();
  if (patch.threadOrTaskId !== undefined) next.threadOrTaskId = String(patch.threadOrTaskId || "").trim();
  if (patch.exitCode !== undefined) {
    next.exitCode = patch.exitCode === null || patch.exitCode === "" ? null : Number(patch.exitCode);
  }
  if (patch.pid !== undefined) {
    next.pid = patch.pid === null || patch.pid === "" ? null : Number(patch.pid);
  }
  if (patch.heartbeatAt !== undefined) next.heartbeatAt = patch.heartbeatAt;
  next.updatedAt = patch.updatedAt || nowIso();
  return next;
}

function withHeartbeatTimeout(slots) {
  const now = Date.now();
  return slots.map(slot => {
    if (slot.status !== "running" || !slot.heartbeatAt || !slot.pid) {
      return slot;
    }
    const age = now - Date.parse(slot.heartbeatAt);
    if (Number.isNaN(age) || age <= HEARTBEAT_TIMEOUT_MS) {
      return slot;
    }
    return applyPatch(slot, {
      status: "error",
      detail: "Heartbeat abgelaufen",
      exitCode: slot.exitCode ?? 1,
      pid: null,
      heartbeatAt: null
    });
  });
}

async function loadEffectiveSlots() {
  const slots = withHeartbeatTimeout(await readSlots());
  await writeSlots(slots);
  return slots;
}

async function updateSlot(slotNumber, patch) {
  const slots = await readSlots();
  const slotIndex = normalizeSlot(slotNumber) - 1;
  slots[slotIndex] = applyPatch(slots[slotIndex], patch);
  await writeSlots(slots);
  return slots[slotIndex];
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function printUsage() {
  console.log(`Codex Monitor Bridge

Commands:
  serve
  init
  list
  clear --slot <1-4>
  set-status --slot <1-4> --status <idle|running|needs_input|error|done> [--label "..."] [--detail "..."] [--thread "..."] [--exit-code 0]
  heartbeat --slot <1-4>
  start --slot <1-4> --label "Build" --command "npm run build"

API:
  GET  /health
  GET  /slots
  POST /slots/:slot
`);
}

async function startCommand(args) {
  const slot = normalizeSlot(args.slot);
  const label = String(args.label || slotLabel(slot));
  const command = String(args.command || "").trim();
  const threadOrTaskId = String(args.thread || "").trim();

  if (!command) {
    throw new Error("start requires --command");
  }

  const child = spawn(command, {
    shell: true,
    windowsHide: false,
    cwd: process.cwd(),
    env: process.env
  });

  await updateSlot(slot, {
    label,
    status: "running",
    detail: "Gestartet",
    threadOrTaskId,
    exitCode: null,
    pid: child.pid,
    heartbeatAt: nowIso()
  });

  const heartbeat = setInterval(() => {
    updateSlot(slot, {
      status: "running",
      detail: "Laeuft",
      pid: child.pid,
      heartbeatAt: nowIso()
    }).catch(() => {});
  }, 5_000);

  child.on("exit", async code => {
    clearInterval(heartbeat);
    await updateSlot(slot, {
      status: code === 0 ? "done" : "error",
      detail: code === 0 ? "Erfolgreich beendet" : `Mit Fehler beendet (${code ?? 1})`,
      exitCode: code ?? 1,
      pid: null,
      heartbeatAt: null
    });
  });

  child.on("error", async error => {
    clearInterval(heartbeat);
    await updateSlot(slot, {
      status: "error",
      detail: `Startfehler: ${error.message}`,
      exitCode: 1,
      pid: null,
      heartbeatAt: null
    });
  });

  console.log(`Started slot ${slot} with PID ${child.pid}: ${command}`);
}

async function serve() {
  await ensureDataFile();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, port: PORT, dataFile: DATA_FILE });
        return;
      }

      if (req.method === "GET" && url.pathname === "/slots") {
        sendJson(res, 200, await loadEffectiveSlots());
        return;
      }

      const slotMatch = url.pathname.match(/^\/slots\/(\d)$/);
      if (req.method === "POST" && slotMatch) {
        const body = await parseBody(req);
        const slot = normalizeSlot(slotMatch[1]);
        const updated = await updateSlot(slot, {
          label: body.label,
          status: body.status,
          detail: body.detail,
          threadOrTaskId: body.threadOrTaskId,
          exitCode: body.exitCode,
          pid: body.pid,
          heartbeatAt: body.status === "running" ? nowIso() : body.heartbeatAt ?? null
        });
        sendJson(res, 200, updated);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Codex Monitor Bridge listening on http://${HOST}:${PORT}`);
    console.log(`State file: ${DATA_FILE}`);
  });
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "serve":
      await serve();
      return;
    case "init":
      await ensureDataFile();
      console.log(DATA_FILE);
      return;
    case "list":
      console.log(JSON.stringify(await loadEffectiveSlots(), null, 2));
      return;
    case "clear": {
      const slot = normalizeSlot(args.slot);
      console.log(JSON.stringify(await updateSlot(slot, createDefaultSlot(slot)), null, 2));
      return;
    }
    case "heartbeat": {
      const slot = normalizeSlot(args.slot);
      console.log(JSON.stringify(await updateSlot(slot, { heartbeatAt: nowIso(), status: "running" }), null, 2));
      return;
    }
    case "set-status": {
      const slot = normalizeSlot(args.slot);
      const patch = {
        label: args.label,
        status: normalizeStatus(String(args.status)),
        detail: args.detail,
        threadOrTaskId: args.thread,
        exitCode: args["exit-code"],
        pid: args.pid,
        heartbeatAt: args.status === "running" ? nowIso() : null
      };
      console.log(JSON.stringify(await updateSlot(slot, patch), null, 2));
      return;
    }
    case "start":
      await startCommand(args);
      return;
    default:
      printUsage();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
