import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.CODEX_MONITOR_PORT || 4567);
const HOST = process.env.CODEX_MONITOR_HOST || "127.0.0.1";
const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodexStreamDeckMonitor");
const DATA_FILE = path.join(DATA_DIR, "slots.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");
const THREAD_NAMES_FILE = path.join(DATA_DIR, "thread-names.json");
const THREADS_FILE = path.join(DATA_DIR, "threads.json");
const CODEX_LOG_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Packages",
  "OpenAI.Codex_2p2nqsd0c76g0",
  "LocalCache",
  "Local",
  "Codex",
  "Logs"
);
const HEARTBEAT_TIMEOUT_MS = 30_000;
const ENABLE_PROCESS_AUTODETECT = process.env.CODEX_MONITOR_AUTODETECT_PROCESSES === "1";
const VALID_STATUSES = new Set(["idle", "running", "needs_input", "error", "done"]);
const VALID_AGENT_STATUSES = new Set(["online", "attention", "offline"]);
const AGENT_ORDER = ["noah", "carmen"];
const execFileAsync = promisify(execFile);
const AGENT_HEARTBEAT_TIMEOUT_MS = 90_000;
const AGENT_PROBE_TTL_MS = 15_000;
const THREAD_HEARTBEAT_TIMEOUT_MS = Number(process.env.CODEX_MONITOR_THREAD_HEARTBEAT_TIMEOUT_MS || 180_000);
const THREAD_DONE_TTL_MS = Number(process.env.CODEX_MONITOR_THREAD_DONE_TTL_MS || 900_000);
const THREAD_NEEDS_INPUT_TTL_MS = Number(process.env.CODEX_MONITOR_THREAD_NEEDS_INPUT_TTL_MS || 86_400_000);
const THREAD_RUNNING_WINDOW_MS = 300_000;
const THREAD_DONE_WINDOW_MS = 120_000;
const AGENT_ACTIVITY_WINDOW_MS = 600_000;
const ENABLE_CODEX_LOG_AUTODETECT = process.env.CODEX_MONITOR_AUTODETECT_CODEX !== "0";
const ENABLE_REMOTE_AGENT_ACTIVITY = process.env.CODEX_MONITOR_REMOTE_AGENT_ACTIVITY === "1";
const AGENT_REMOTE_DEFAULTS = {
  noah: {
    kind: "ssh-json",
    host: process.env.CODEX_MONITOR_NOAH_SSH_HOST || "ocvps",
    command:
      process.env.CODEX_MONITOR_NOAH_STATUS_COMMAND ||
      "python3 - <<'PY'\nfrom pathlib import Path\nimport json\nbase=Path('/root/.openclaw/workspace/.pi')\nfiles={\n  'paper_cycle': base/'paper_cycle.log.jsonl',\n  'main_bundle': base/'artifacts'/'noah3'/'main_decision_bundle.json',\n  'companion_log': base/'companion_api.log',\n  'companion_access_log': base/'companion_api_access.log.jsonl',\n  'owner_health_alert_state': base/'owner_health_alert_state.json',\n  'main_sessions': Path('/root/.openclaw/agents/main/sessions')/'sessions.json',\n}\nout={}\nfor key, path in files.items():\n    out[key]={'exists': path.exists(), 'mtime': path.stat().st_mtime if path.exists() else None}\nlatest_session=None\nsessions_dir=Path('/root/.openclaw/agents/main/sessions')\nif sessions_dir.exists():\n    files=sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session={'exists': True, 'mtime': files[0].stat().st_mtime, 'name': files[0].name}\nout['latest_session']=latest_session\nprint(json.dumps(out))\nPY"
  },
  carmen: {
    kind: "ssh-json",
    host: process.env.CODEX_MONITOR_CARMEN_SSH_HOST || "carmen-vps",
    command:
      process.env.CODEX_MONITOR_CARMEN_STATUS_COMMAND ||
      "python3 - <<'PY'\nfrom pathlib import Path\nimport json, subprocess\nstatus = json.loads(subprocess.check_output(['python3','/root/.openclaw/workspace/integrations/whatsapp/vnext_status.py'], text=True))\nsessions_dir = Path('/root/.openclaw/agents/main/sessions')\nlatest_session_mtime = None\nlatest_session_file = None\nif sessions_dir.exists():\n    files = sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session_file = files[0].name\n        latest_session_mtime = files[0].stat().st_mtime\nroots = [\n    Path('/root/.openclaw/workspace/integrations/whatsapp/logs'),\n    Path('/root/.openclaw/workspace/integrations/whatsapp/state'),\n    Path('/root/.openclaw/agents/main/sessions'),\n]\nrecent_mtime = None\nrecent_file = None\nfor root in roots:\n    if not root.exists():\n        continue\n    for candidate in root.rglob('*'):\n        try:\n            if not candidate.is_file():\n                continue\n            mtime = candidate.stat().st_mtime\n        except Exception:\n            continue\n        if recent_mtime is None or mtime > recent_mtime:\n            recent_mtime = mtime\n            recent_file = str(candidate)\nstatus['mainSessions'] = {'latestFile': latest_session_file, 'latestMtime': latest_session_mtime}\nstatus['activityFiles'] = {'latestFile': recent_file, 'latestMtime': recent_mtime}\nprint(json.dumps(status))\nPY"
  }
};
const agentProbeCache = new Map();
const agentProbeInflight = new Map();

function nowIso() {
  return new Date().toISOString();
}

function formatCodexLogDateDir(date, useUtc = false) {
  const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
  const month = String((useUtc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(useUtc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  return path.join(CODEX_LOG_ROOT, String(year), month, day);
}

function unique(values) {
  return Array.from(new Set(values));
}

function toIsoDate(value) {
  if (!value) {
    return nowIso();
  }
  const raw = String(value);
  const cimMatch = raw.match(/\/Date\((\d+)\)\//);
  if (cimMatch) {
    return new Date(Number(cimMatch[1])).toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? nowIso() : date.toISOString();
}

function slotLabel(slot) {
  return `Codex ${slot}`;
}

function agentLabel(agent) {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function createDefaultSlot(slot) {
  return {
    slot,
    label: slotLabel(slot),
    status: "idle",
    detail: "Bereit",
    updatedAt: nowIso(),
    startedAt: null,
    threadOrTaskId: "",
    exitCode: null,
    pid: null,
    heartbeatAt: null,
    source: "manual"
  };
}

function createDefaultAgent(name) {
  return {
    name,
    label: agentLabel(name),
    status: "offline",
    detail: "Offline",
    updatedAt: nowIso(),
    lastSeenAt: null,
    heartbeatAt: null,
    activity: false,
    blinkUntil: null
  };
}

function createDefaultThread(threadId = "") {
  return {
    threadId,
    slot: null,
    label: "",
    status: "running",
    detail: "Aktiver Thread",
    updatedAt: nowIso(),
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    exitCode: null,
    source: "codex-app"
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

  try {
    await readFile(AGENTS_FILE, "utf8");
  } catch {
    await writeFile(
      AGENTS_FILE,
      `${JSON.stringify(AGENT_ORDER.map(name => createDefaultAgent(name)), null, 2)}\n`,
      "utf8"
    );
  }

  try {
    await readFile(THREAD_NAMES_FILE, "utf8");
  } catch {
    await writeFile(THREAD_NAMES_FILE, "{}\n", "utf8");
  }

  try {
    await readFile(THREADS_FILE, "utf8");
  } catch {
    await writeFile(THREADS_FILE, "[]\n", "utf8");
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

async function readAgents() {
  await ensureDataFile();
  const raw = await readFile(AGENTS_FILE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const defaults = AGENT_ORDER.map(name => createDefaultAgent(name));
    await writeAgents(defaults);
    return defaults;
  }
  const agents = Array.isArray(parsed) ? parsed : parsed?.agents;
  if (!Array.isArray(agents) || agents.length !== AGENT_ORDER.length) {
    const defaults = AGENT_ORDER.map(name => createDefaultAgent(name));
    await writeAgents(defaults);
    return defaults;
  }
  return AGENT_ORDER.map((name, index) => ({
    ...createDefaultAgent(name),
    ...agents[index],
    name,
    status: normalizeAgentStatus(agents[index]?.status ?? "offline"),
    heartbeatAt: agents[index]?.heartbeatAt ? toIsoDate(agents[index].heartbeatAt) : null,
    lastSeenAt: agents[index]?.lastSeenAt ? toIsoDate(agents[index].lastSeenAt) : null,
    activity: Boolean(agents[index]?.activity),
    blinkUntil: agents[index]?.blinkUntil ? toIsoDate(agents[index].blinkUntil) : null
  }));
}

async function writeSlots(slots) {
  await ensureDataFile();
  await writeFile(DATA_FILE, `${JSON.stringify(slots, null, 2)}\n`, "utf8");
}

async function writeAgents(agents) {
  await ensureDataFile();
  await writeFile(AGENTS_FILE, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
}

async function readThreads() {
  await ensureDataFile();
  const raw = await readFile(THREADS_FILE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await writeThreads([]);
    return [];
  }
  if (!Array.isArray(parsed)) {
    await writeThreads([]);
    return [];
  }
  return parsed
    .filter(item => item && typeof item === "object")
    .map(item => {
      const thread = item || {};
      return {
        ...createDefaultThread(String(thread.threadId || "")),
        ...thread,
        threadId: String(thread.threadId || "").trim(),
        slot:
          thread.slot === null || thread.slot === undefined || thread.slot === ""
            ? null
            : normalizeSlot(thread.slot),
        label: String(thread.label || "").trim(),
        detail: String(thread.detail || "").trim(),
        status: normalizeStatus(String(thread.status || "running")),
        updatedAt: toIsoDate(thread.updatedAt),
        startedAt: thread.startedAt ? toIsoDate(thread.startedAt) : null,
        heartbeatAt: thread.heartbeatAt ? toIsoDate(thread.heartbeatAt) : null,
        finishedAt: thread.finishedAt ? toIsoDate(thread.finishedAt) : null,
        exitCode:
          thread.exitCode === null || thread.exitCode === undefined || thread.exitCode === ""
            ? null
            : Number(thread.exitCode),
        source: String(thread.source || "codex-app")
      };
    })
    .filter(thread => thread.threadId);
}

async function writeThreads(threads) {
  await ensureDataFile();
  await writeFile(THREADS_FILE, `${JSON.stringify(threads, null, 2)}\n`, "utf8");
}

async function readThreadNames() {
  await ensureDataFile();
  try {
    const raw = await readFile(THREAD_NAMES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    await writeFile(THREAD_NAMES_FILE, "{}\n", "utf8");
    return {};
  }
}

async function writeThreadNames(threadNames) {
  await ensureDataFile();
  await writeFile(THREAD_NAMES_FILE, `${JSON.stringify(threadNames, null, 2)}\n`, "utf8");
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

function normalizeAgentName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!AGENT_ORDER.includes(name)) {
    throw new Error(`agent must be one of: ${AGENT_ORDER.join(", ")}`);
  }
  return name;
}

function normalizeAgentStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const mapped =
    normalized === "idle"
      ? "offline"
      : normalized === "active"
        ? "online"
        : normalized === "error"
          ? "attention"
          : normalized;
  if (!VALID_AGENT_STATUSES.has(mapped)) {
    throw new Error(`agent status must be one of: ${Array.from(VALID_AGENT_STATUSES).join(", ")}`);
  }
  return mapped;
}

function normalizeThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId) {
    throw new Error("thread id is required");
  }
  return threadId;
}

function applyPatch(slot, patch) {
  const next = { ...slot };
  if (patch.label !== undefined) next.label = String(patch.label || slotLabel(slot.slot)).trim() || slotLabel(slot.slot);
  if (patch.status !== undefined) {
    const status = normalizeStatus(String(patch.status));
    next.status = status;
    if (status === "running" && !slot.startedAt) {
      next.startedAt = patch.startedAt || nowIso();
    } else if (status !== "running" && patch.startedAt === undefined) {
      next.startedAt = null;
    }
  }
  if (patch.detail !== undefined) next.detail = String(patch.detail || "").trim();
  if (patch.threadOrTaskId !== undefined) next.threadOrTaskId = String(patch.threadOrTaskId || "").trim();
  if (patch.exitCode !== undefined) {
    next.exitCode = patch.exitCode === null || patch.exitCode === "" ? null : Number(patch.exitCode);
  }
  if (patch.pid !== undefined) {
    next.pid = patch.pid === null || patch.pid === "" ? null : Number(patch.pid);
  }
  if (patch.heartbeatAt !== undefined) next.heartbeatAt = patch.heartbeatAt;
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
  if (patch.source !== undefined) next.source = patch.source;
  next.updatedAt = patch.updatedAt || nowIso();
  return next;
}

function applyAgentPatch(agent, patch) {
  const next = { ...agent };
  if (patch.label !== undefined) next.label = String(patch.label || agentLabel(agent.name)).trim() || agentLabel(agent.name);
  if (patch.status !== undefined) next.status = normalizeAgentStatus(String(patch.status));
  if (patch.detail !== undefined) next.detail = String(patch.detail || "").trim();
  if (patch.lastSeenAt !== undefined) next.lastSeenAt = patch.lastSeenAt;
  if (patch.heartbeatAt !== undefined) next.heartbeatAt = patch.heartbeatAt;
  if (patch.activity !== undefined) next.activity = Boolean(patch.activity);
  if (patch.blinkUntil !== undefined) next.blinkUntil = patch.blinkUntil;
  next.updatedAt = patch.updatedAt || nowIso();
  return next;
}

function applyThreadPatch(thread, patch) {
  const next = { ...thread };
  if (patch.slot !== undefined) {
    next.slot = patch.slot === null || patch.slot === "" ? null : normalizeSlot(patch.slot);
  }
  if (patch.label !== undefined) next.label = String(patch.label || "").trim();
  if (patch.status !== undefined) {
    const status = normalizeStatus(String(patch.status));
    next.status = status;
    if (status === "running") {
      next.startedAt = patch.startedAt || thread.startedAt || nowIso();
      next.finishedAt = null;
      next.heartbeatAt = patch.heartbeatAt || nowIso();
      if (patch.exitCode === undefined) {
        next.exitCode = null;
      }
    } else if (status === "done" || status === "error") {
      next.finishedAt = patch.finishedAt || nowIso();
      if (patch.heartbeatAt !== undefined) {
        next.heartbeatAt = patch.heartbeatAt;
      }
    } else if (patch.heartbeatAt !== undefined) {
      next.heartbeatAt = patch.heartbeatAt;
    }
  } else if (patch.heartbeatAt !== undefined) {
    next.heartbeatAt = patch.heartbeatAt;
  }
  if (patch.detail !== undefined) next.detail = String(patch.detail || "").trim();
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
  if (patch.exitCode !== undefined) {
    next.exitCode = patch.exitCode === null || patch.exitCode === "" ? null : Number(patch.exitCode);
  }
  if (patch.source !== undefined) next.source = String(patch.source || next.source || "codex-app");
  next.updatedAt = patch.updatedAt || nowIso();
  return next;
}

function compareThreadFreshness(left, right) {
  const leftMs = Date.parse(left.updatedAt || left.heartbeatAt || left.startedAt || nowIso());
  const rightMs = Date.parse(right.updatedAt || right.heartbeatAt || right.startedAt || nowIso());
  return rightMs - leftMs;
}

function selectThreadToRecycle(threads, excludedThreadId) {
  const candidates = threads.filter(thread => thread.threadId !== excludedThreadId && thread.slot !== null);
  if (!candidates.length) {
    return null;
  }
  const priority = { done: 0, error: 1, running: 2, needs_input: 3 };
  return candidates.sort((left, right) => {
    const leftPriority = priority[left.status] ?? 99;
    const rightPriority = priority[right.status] ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return Date.parse(left.updatedAt || left.startedAt || nowIso()) - Date.parse(right.updatedAt || right.startedAt || nowIso());
  })[0];
}

function assignThreadSlot(threads, threadId, requestedSlot) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const existing = threads.find(thread => thread.threadId === normalizedThreadId);
  const usedSlots = new Set(
    threads
      .filter(thread => thread.threadId !== normalizedThreadId && thread.slot !== null)
      .map(thread => thread.slot)
  );

  if (requestedSlot !== undefined && requestedSlot !== null && requestedSlot !== "") {
    const preferred = normalizeSlot(requestedSlot);
    if (!usedSlots.has(preferred) || existing?.slot === preferred) {
      return preferred;
    }
  }

  if (existing?.slot !== null && existing?.slot !== undefined) {
    return existing.slot;
  }

  for (let slot = 1; slot <= 4; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  const recycled = selectThreadToRecycle(threads, normalizedThreadId);
  if (!recycled || recycled.slot === null) {
    return 1;
  }
  const recycledSlot = recycled.slot;
  recycled.slot = null;
  return recycledSlot;
}

function normalizeExplicitThreads(threads) {
  const now = Date.now();
  return threads
    .map(thread => {
      const next = { ...thread };
      if (next.status === "running") {
        const heartbeatMs = Date.parse(next.heartbeatAt || next.updatedAt || "");
        if (!Number.isNaN(heartbeatMs) && now - heartbeatMs > THREAD_HEARTBEAT_TIMEOUT_MS) {
          next.status = "error";
          next.detail = "Signal verloren";
          next.finishedAt = next.finishedAt || nowIso();
          next.exitCode = next.exitCode ?? 1;
          next.heartbeatAt = null;
          next.updatedAt = nowIso();
        }
      }
      return next;
    })
    .filter(thread => {
      const referenceMs = Date.parse(
        thread.finishedAt || thread.heartbeatAt || thread.updatedAt || thread.startedAt || nowIso()
      );
      if (Number.isNaN(referenceMs)) {
        return true;
      }
      if (thread.status === "done" || thread.status === "error") {
        return now - referenceMs <= THREAD_DONE_TTL_MS;
      }
      if (thread.status === "needs_input") {
        return now - referenceMs <= THREAD_NEEDS_INPUT_TTL_MS;
      }
      return true;
    })
    .sort(compareThreadFreshness);
}

function threadToSlotState(thread, threadNames) {
  return {
    slot: thread.slot,
    label: thread.label || String(threadNames[thread.threadId] || "").trim() || `Chat ${thread.slot}`,
    status: thread.status,
    detail: thread.detail || (thread.status === "running" ? "Aktiver Thread" : "Thread aktiv"),
    updatedAt: thread.updatedAt,
    startedAt: thread.startedAt,
    threadOrTaskId: thread.threadId,
    exitCode: thread.exitCode,
    pid: null,
    heartbeatAt: thread.heartbeatAt,
    autodetected: false,
    source: thread.source || "codex-app"
  };
}

function overlayExplicitThreads(slots, threadSlots) {
  const bySlot = new Map(threadSlots.map(thread => [thread.slot, thread]));
  return slots.map(slot => {
    if (slot.status !== "idle") {
      return slot;
    }
    const thread = bySlot.get(slot.slot);
    if (!thread) {
      return slot;
    }
    return {
      ...slot,
      ...thread,
      slot: slot.slot
    };
  });
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

async function discoverCodexProcesses() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'Codex.exe' OR Name = 'codex.exe'\" | Select-Object ProcessId, Name, CreationDate, CommandLine | ConvertTo-Json -Compress"
    ]);
    if (!stdout.trim()) {
      return [];
    }

    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter(item => {
        const commandLine = String(item.CommandLine || "");
        return !commandLine.includes("--type=") && !commandLine.includes("crashpad-handler");
      })
      .map(item => ({
        pid: Number(item.ProcessId),
        processName: String(item.Name || "Codex.exe"),
        title: String(item.CommandLine || "").includes("app-server") ? "Codex Service" : "Codex Desktop",
        startedAt: toIsoDate(item.CreationDate)
      }))
      .filter(item => Number.isInteger(item.pid));
  } catch {
    return [];
  }
}

function overlayDiscoveredProcesses(slots, processes) {
  const trackedPids = new Set(slots.map(slot => slot.pid).filter(pid => Number.isInteger(pid)));
  const discovered = processes.filter(processInfo => !trackedPids.has(processInfo.pid));
  let discoveredIndex = 0;

  return slots.map(slot => {
    if (slot.status !== "idle") {
      return slot;
    }
    const processInfo = discovered[discoveredIndex];
    if (!processInfo) {
      return slot;
    }
    discoveredIndex += 1;
    return {
      ...slot,
      label: processInfo.title || `Codex ${slot.slot}`,
      status: "running",
      detail: "Codex aktiv",
      updatedAt: nowIso(),
      startedAt: processInfo.startedAt,
      pid: processInfo.pid,
      heartbeatAt: processInfo.startedAt,
      autodetected: true,
      source: "process"
    };
  });
}

function chooseWorkspaceLabel(fileContent) {
  const matches = Array.from(fileContent.matchAll(/cwd="([^"]+)"/g)).map(match => String(match[1] || ""));
  if (!matches.length) {
    return "";
  }

  const counts = new Map();
  for (const rawPath of matches) {
    const normalized = rawPath.replace(/[\\/]\.git$/i, "").replaceAll("/", path.sep);
    const basename = path.basename(normalized);
    if (!basename) {
      continue;
    }
    counts.set(basename, (counts.get(basename) || 0) + 1);
  }

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

async function discoverCodexConversations() {
  try {
    const threadNames = await readThreadNames();
    const datesToCheck = Array.from({ length: 3 }, (_, offset) => {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      return date;
    });
    const candidateDirs = unique(
      datesToCheck.flatMap(date => [formatCodexLogDateDir(date, false), formatCodexLogDateDir(date, true)])
    );
    const namesByDir = await Promise.all(
      candidateDirs.map(async dateDir => {
        try {
          return (await readdir(dateDir)).map(name => ({ dateDir, name }));
        } catch {
          return [];
        }
      })
    );
    const entries = await Promise.all(
      namesByDir
        .flat()
        .filter(({ name }) => name.startsWith("codex-desktop-") && name.endsWith(".log"))
        .map(async ({ dateDir, name }) => {
          const fullPath = path.join(dateDir, name);
          const fileStat = await stat(fullPath);
          return { fullPath, mtimeMs: fileStat.mtimeMs };
        })
    );
    const recentFiles = entries.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 6);
    const conversations = new Map();

    for (const file of recentFiles) {
      const content = await readFile(file.fullPath, "utf8");
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        const eventMatch = line.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z).+conversationId=([0-9a-f-]+).+method=(turn\/start|turn\/steer|turn\/interrupt|thread\/metadata\/update|thread\/name\/set|thread\/rollback)/
        );
        if (eventMatch) {
          const [, timestamp, conversationId, method] = eventMatch;
          const current = conversations.get(conversationId) || {
            conversationId,
            updatedAt: timestamp,
            lastMethod: method,
            lastStartAt: null,
            lastActivityAt: null,
            lastStopAt: null,
            filePath: file.fullPath
          };
          current.updatedAt = timestamp;
          current.lastMethod = method;
          current.filePath = file.fullPath;
          if (method === "turn/start") {
            current.lastStartAt = timestamp;
            current.lastActivityAt = timestamp;
          } else if (method === "turn/steer" || method === "thread/metadata/update") {
            current.lastActivityAt = timestamp;
          } else if (method === "turn/interrupt" || method === "thread/rollback") {
            current.lastStopAt = timestamp;
          }
          conversations.set(conversationId, current);
        }

        const completeMatch = line.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z).+show turn-complete conversationId=([0-9a-f-]+)/
        );
        if (completeMatch) {
          const [, timestamp, conversationId] = completeMatch;
          const current = conversations.get(conversationId) || {
            conversationId,
            updatedAt: timestamp,
            lastMethod: "turn/complete",
            lastStartAt: null,
            lastActivityAt: null,
            lastStopAt: null,
            filePath: file.fullPath
          };
          current.updatedAt = timestamp;
          current.lastMethod = "turn/complete";
          current.lastStopAt = timestamp;
          current.filePath = file.fullPath;
          conversations.set(conversationId, current);
        }
      }
    }

    const candidateConversations = Array.from(conversations.values())
      .map(conversation => {
        const lastStartMs = conversation.lastStartAt ? Date.parse(conversation.lastStartAt) : NaN;
        const lastActivityMs = conversation.lastActivityAt ? Date.parse(conversation.lastActivityAt) : NaN;
        const lastStopMs = conversation.lastStopAt ? Date.parse(conversation.lastStopAt) : NaN;
        const latestRunSignalMs = Number.isNaN(lastActivityMs) ? lastStartMs : Math.max(lastStartMs, lastActivityMs);
        const hasRunSignal = !Number.isNaN(latestRunSignalMs);
        const latestVisibleMs = hasRunSignal
          ? latestRunSignalMs
          : !Number.isNaN(lastStopMs)
            ? lastStopMs
            : NaN;

        if (Number.isNaN(latestVisibleMs)) {
          return null;
        }

        let status = "running";
        let detail = "Aktiver Thread";
        if (!Number.isNaN(lastStopMs) && (Number.isNaN(latestRunSignalMs) || lastStopMs >= latestRunSignalMs)) {
          if (Date.now() - lastStopMs > THREAD_DONE_WINDOW_MS) {
            return null;
          }
          status = "done";
          detail = "Antwort fertig";
        }
        else if (!hasRunSignal || Date.now() - latestRunSignalMs > THREAD_RUNNING_WINDOW_MS) {
          return null;
        }
        return {
          ...conversation,
          latestVisibleAt: new Date(latestVisibleMs).toISOString(),
          status,
          detail
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftMs = Date.parse(left.latestVisibleAt || left.updatedAt);
        const rightMs = Date.parse(right.latestVisibleAt || right.updatedAt);
        return rightMs - leftMs;
      })
      .filter(conversation => {
        if (conversation.status === "done") {
          return Date.now() - Date.parse(conversation.latestVisibleAt || conversation.updatedAt) <= THREAD_DONE_WINDOW_MS;
        }
        return true;
      });

    const dedupedConversations = [];
    const seenLabels = new Set();
    for (const conversation of candidateConversations) {
      const resolvedLabel = String(threadNames[conversation.conversationId] || "").trim();
      const dedupeKey = resolvedLabel ? resolvedLabel.toLowerCase() : "";
      if (dedupeKey && seenLabels.has(dedupeKey)) {
        continue;
      }
      if (dedupeKey) {
        seenLabels.add(dedupeKey);
      }
      dedupedConversations.push(conversation);
    }

    return dedupedConversations
      .slice(0, 4)
      .map((conversation, index) => ({
        slot: index + 1,
        label: String(threadNames[conversation.conversationId] || "").trim() || `Chat ${index + 1}`,
        status: conversation.status,
        detail: conversation.detail,
        updatedAt: conversation.latestVisibleAt || conversation.updatedAt,
        startedAt: conversation.lastStartAt || conversation.updatedAt,
        threadOrTaskId: conversation.conversationId,
        exitCode: null,
        pid: null,
        heartbeatAt: conversation.latestVisibleAt || conversation.updatedAt,
        autodetected: false,
        source: "codex"
      }));
  } catch {
    return [];
  }
}

function overlayDiscoveredConversations(slots, conversations) {
  const trackedThreads = new Set(slots.map(slot => slot.threadOrTaskId).filter(Boolean));
  const candidates = conversations.filter(conversation => !trackedThreads.has(conversation.threadOrTaskId));
  let candidateIndex = 0;

  return slots.map(slot => {
    if (slot.status !== "idle") {
      return slot;
    }
    const conversation = candidates[candidateIndex];
    if (!conversation) {
      return slot;
    }
    candidateIndex += 1;
    return {
      ...slot,
      ...conversation,
      slot: slot.slot
    };
  });
}

async function loadEffectiveSlots() {
  const storedSlots = withHeartbeatTimeout(await readSlots());
  const cleanedSlots = storedSlots.map(slot => {
    const isEphemeralSource = slot.source === "codex" || slot.source === "process";
    const isLegacyCodexOverlay =
      !slot.pid &&
      typeof slot.threadOrTaskId === "string" &&
      slot.threadOrTaskId &&
      ["Aktiver Thread", "Antwort fertig"].includes(String(slot.detail || ""));
    const isLegacyProcessOverlay =
      slot.autodetected ||
      (String(slot.detail || "") === "Codex aktiv" && /^Codex (Desktop|Service)/.test(String(slot.label || "")));

    if (!isEphemeralSource && !isLegacyCodexOverlay && !isLegacyProcessOverlay) {
      return slot;
    }

    return createDefaultSlot(slot.slot);
  });

  if (JSON.stringify(cleanedSlots) !== JSON.stringify(storedSlots)) {
    await writeSlots(cleanedSlots);
  }

  const threadNames = await readThreadNames();
  const explicitThreads = await loadExplicitThreads();
  const explicitThreadSlots = explicitThreads
    .filter(thread => thread.slot !== null)
    .map(thread => threadToSlotState(thread, threadNames))
    .sort((left, right) => left.slot - right.slot);
  const withExplicitThreads = overlayExplicitThreads(cleanedSlots, explicitThreadSlots);
  const shouldUseCodexFallback = ENABLE_CODEX_LOG_AUTODETECT && explicitThreadSlots.length === 0;
  const discoveredConversations = shouldUseCodexFallback ? await discoverCodexConversations() : [];
  const withConversations = overlayDiscoveredConversations(withExplicitThreads, discoveredConversations);
  if (!ENABLE_PROCESS_AUTODETECT) {
    return withConversations;
  }
  const discoveredProcesses = await discoverCodexProcesses();
  return overlayDiscoveredProcesses(withConversations, discoveredProcesses);
}

async function loadEffectiveAgents() {
  const agents = await readAgents();
  const now = Date.now();
  const heartbeatNormalized = agents.map(agent => {
    if (agent.status === "offline" || !agent.heartbeatAt) {
      return agent;
    }
    const age = now - Date.parse(agent.heartbeatAt);
    if (Number.isNaN(age) || age <= AGENT_HEARTBEAT_TIMEOUT_MS) {
      return agent;
    }
    return applyAgentPatch(agent, {
      status: "offline",
      detail: "Kein Signal",
      activity: false,
      heartbeatAt: null,
      blinkUntil: null
    });
  });
  const remotelyProbed = await overlayRemoteAgentStates(heartbeatNormalized);
  await writeAgents(remotelyProbed);
  return remotelyProbed;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "ja", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "nein", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function futureIso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(4_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function runSshJson(host, command) {
  const { stdout } = await execFileAsync(
    "ssh",
    [host, command],
    {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
  );
  const output = String(stdout || "").trim();
  return output ? JSON.parse(output) : {};
}

function makeProbeResult(status, detail, extra = {}) {
  return {
    status,
    detail,
    checkedAt: nowIso(),
    ...extra
  };
}

function isRecentUnixTimestamp(value, thresholdSeconds) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return false;
  }
  return Date.now() - timestamp * 1000 <= thresholdSeconds * 1000;
}

function isRecentIsoTimestamp(value, thresholdMs = AGENT_ACTIVITY_WINDOW_MS) {
  const timestamp = Date.parse(String(value || ""));
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= thresholdMs;
}

async function probeNoahRemote() {
  try {
    const payload = await runSshJson(AGENT_REMOTE_DEFAULTS.noah.host, AGENT_REMOTE_DEFAULTS.noah.command);
    const paperCycleMtime = payload?.paper_cycle?.mtime;
    const mainBundleMtime = payload?.main_bundle?.mtime;
    const companionLogMtime = payload?.companion_log?.mtime;
    const companionAccessLogMtime = payload?.companion_access_log?.mtime;
    const ownerHealthAlertStateMtime = payload?.owner_health_alert_state?.mtime;
    const mainSessionsMtime = payload?.main_sessions?.mtime;
    const latestSessionMtime = payload?.latest_session?.mtime;
    const latestActivity = Math.max(
      Number(paperCycleMtime || 0),
      Number(mainBundleMtime || 0),
      Number(companionLogMtime || 0),
      Number(companionAccessLogMtime || 0),
      Number(ownerHealthAlertStateMtime || 0),
      Number(mainSessionsMtime || 0),
      Number(latestSessionMtime || 0)
    );
    return makeProbeResult("online", "VPS erreichbar", {
      activityMetric: String(latestActivity || 0),
      recentActivity: isRecentUnixTimestamp(latestActivity, AGENT_ACTIVITY_WINDOW_MS / 1000)
    });
  } catch (error) {
    return makeProbeResult("offline", `VPS offline: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeCarmenRemote() {
  try {
    const payload = await runSshJson(AGENT_REMOTE_DEFAULTS.carmen.host, AGENT_REMOTE_DEFAULTS.carmen.command);
    const receiverOk = Boolean(payload?.receiver?.ok);
    const nodeReady = Boolean(payload?.node?.ready);
    const nodeAuthenticated = Boolean(payload?.node?.authenticated);
    const mode = String(payload?.mode || payload?.node?.pushVNext?.runtimeMode || "online");
    const lastAcceptedSeq = Number(payload?.receiver?.lastAcceptedSeq || 0);
    const lastProcessedSeq = Number(payload?.receiver?.lastProcessedSeq || 0);
    const latestSeq = Number(payload?.node?.latestSeq || 0);
    const lastEventAt = payload?.node?.lastEventAt ? Date.parse(String(payload.node.lastEventAt)) : NaN;
    const latestSessionMtime = Number(payload?.mainSessions?.latestMtime || 0);
    const latestActivityFileMtime = Number(payload?.activityFiles?.latestMtime || 0);
    const hasRecentActivity =
      (!Number.isNaN(lastEventAt) && Date.now() - lastEventAt <= AGENT_ACTIVITY_WINDOW_MS) ||
      isRecentIsoTimestamp(payload?.receiver?.lastAcceptedAt, AGENT_ACTIVITY_WINDOW_MS) ||
      isRecentIsoTimestamp(payload?.receiver?.lastProcessedAt, AGENT_ACTIVITY_WINDOW_MS) ||
      isRecentUnixTimestamp(latestSessionMtime, AGENT_ACTIVITY_WINDOW_MS / 1000) ||
      isRecentUnixTimestamp(latestActivityFileMtime, AGENT_ACTIVITY_WINDOW_MS / 1000);

    if (payload?.ok && receiverOk && nodeReady && nodeAuthenticated) {
      return makeProbeResult("online", `VPS online (${mode})`, {
        activityMetric: `${lastAcceptedSeq}:${lastProcessedSeq}:${latestSeq}:${latestSessionMtime}:${latestActivityFileMtime}`,
        recentActivity: hasRecentActivity
      });
    }

    if (payload?.ok) {
      return makeProbeResult("attention", "Carmen laeuft, aber Transport ist nicht voll bereit");
    }

    return makeProbeResult("attention", "Carmen meldet Problem");
  } catch (error) {
    return makeProbeResult("offline", `VPS offline: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeRemoteAgent(name) {
  if (name === "noah") {
    return probeNoahRemote();
  }
  if (name === "carmen") {
    return probeCarmenRemote();
  }
  return makeProbeResult("offline", "Keine Probe definiert");
}

async function getCachedAgentProbe(name) {
  const cached = agentProbeCache.get(name);
  if (cached && Date.now() - cached.cachedAt <= AGENT_PROBE_TTL_MS) {
    return cached.result;
  }

  if (agentProbeInflight.has(name)) {
    return agentProbeInflight.get(name);
  }

  const promise = probeRemoteAgent(name)
    .then(result => {
      const previousEntry = agentProbeCache.get(name);
      agentProbeCache.set(name, {
        cachedAt: Date.now(),
        result,
        previousResult: previousEntry?.result
      });
      agentProbeInflight.delete(name);
      return result;
    })
    .catch(error => {
      agentProbeInflight.delete(name);
      const fallback = makeProbeResult("offline", `Probe fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      const previousEntry = agentProbeCache.get(name);
      agentProbeCache.set(name, {
        cachedAt: Date.now(),
        result: fallback,
        previousResult: previousEntry?.result
      });
      return fallback;
    });

  agentProbeInflight.set(name, promise);
  return promise;
}

async function overlayRemoteAgentStates(agents) {
  const results = await Promise.all(AGENT_ORDER.map(name => getCachedAgentProbe(name)));
  return agents.map((agent, index) => {
    const probe = results[index];
    const next = { ...agent };
    const heartbeatAge = agent.heartbeatAt ? Date.now() - Date.parse(agent.heartbeatAt) : Number.POSITIVE_INFINITY;
    const hasRecentExplicitSignal =
      Number.isFinite(heartbeatAge) &&
      heartbeatAge <= AGENT_HEARTBEAT_TIMEOUT_MS &&
      (agent.activity || agent.status === "attention");
    const previous = agentProbeCache.get(agent.name)?.previousResult;
    const changedActivityMetric =
      ENABLE_REMOTE_AGENT_ACTIVITY &&
      probe.activityMetric !== undefined &&
      previous?.activityMetric !== undefined &&
      probe.activityMetric !== previous.activityMetric;
    const shouldBlink =
      ENABLE_REMOTE_AGENT_ACTIVITY &&
      Boolean(probe.recentActivity || changedActivityMetric);

    if (hasRecentExplicitSignal) {
      next.updatedAt = probe.checkedAt;
      return next;
    }

    if (probe.status === "offline") {
      next.status = "offline";
      next.detail = probe.detail;
      next.activity = false;
      next.blinkUntil = null;
      next.heartbeatAt = null;
      next.lastSeenAt = null;
      next.updatedAt = probe.checkedAt;
      return next;
    }

    next.status = probe.status;
    next.detail = probe.detail;
    next.updatedAt = probe.checkedAt;
    next.lastSeenAt = probe.checkedAt;
    next.activity = shouldBlink;
    next.blinkUntil = shouldBlink ? futureIso(20_000) : null;
    return next;
  });
}

async function updateSlot(slotNumber, patch) {
  const slots = await readSlots();
  const slotIndex = normalizeSlot(slotNumber) - 1;
  slots[slotIndex] = applyPatch(slots[slotIndex], patch);
  await writeSlots(slots);
  return slots[slotIndex];
}

async function updateAgent(agentName, patch) {
  const name = normalizeAgentName(agentName);
  const agents = await readAgents();
  const index = AGENT_ORDER.indexOf(name);
  agents[index] = applyAgentPatch(agents[index], patch);
  await writeAgents(agents);
  return agents[index];
}

async function loadExplicitThreads() {
  const storedThreads = await readThreads();
  const normalizedThreads = normalizeExplicitThreads(storedThreads);
  if (JSON.stringify(normalizedThreads) !== JSON.stringify(storedThreads)) {
    await writeThreads(normalizedThreads);
  }
  return normalizedThreads;
}

async function rememberThreadLabel(threadId, label) {
  const threadNames = await readThreadNames();
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedLabel = String(label || "").trim();
  if (!normalizedLabel) {
    delete threadNames[normalizedThreadId];
  } else {
    threadNames[normalizedThreadId] = normalizedLabel;
  }
  await writeThreadNames(threadNames);
  return normalizedLabel;
}

async function clearThread(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const threads = await readThreads();
  const remaining = threads.filter(thread => thread.threadId !== normalizedThreadId);
  await writeThreads(normalizeExplicitThreads(remaining));
  return {
    threadId: normalizedThreadId,
    cleared: true
  };
}

async function updateThread(threadId, patch = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (patch.clear) {
    return clearThread(normalizedThreadId);
  }

  const threads = await readThreads();
  const index = threads.findIndex(thread => thread.threadId === normalizedThreadId);
  const current = index >= 0 ? threads[index] : createDefaultThread(normalizedThreadId);
  const assignedSlot =
    patch.slot !== undefined
      ? assignThreadSlot(threads, normalizedThreadId, patch.slot)
      : assignThreadSlot(threads, normalizedThreadId, current.slot);
  const next = applyThreadPatch(
    {
      ...current,
      threadId: normalizedThreadId,
      slot: assignedSlot
    },
    {
      ...patch,
      slot: assignedSlot,
      source: patch.source || current.source || "codex-app"
    }
  );

  if (index >= 0) {
    threads[index] = next;
  } else {
    threads.push(next);
  }

  if (patch.label !== undefined) {
    await rememberThreadLabel(normalizedThreadId, patch.label);
  }

  const normalizedThreads = normalizeExplicitThreads(threads);
  await writeThreads(normalizedThreads);
  return normalizedThreads.find(thread => thread.threadId === normalizedThreadId) || next;
}

async function setThreadName(threadId, label) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    throw new Error("thread id is required");
  }
  const normalizedLabel = await rememberThreadLabel(normalizedThreadId, label);
  return {
    threadOrTaskId: normalizedThreadId,
    label: normalizedLabel
  };
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
  threads
  state
  clear --slot <1-4>
  set-status --slot <1-4> --status <idle|running|needs_input|error|done> [--label "..."] [--detail "..."] [--thread "..."] [--exit-code 0]
  set-agent --agent <noah|carmen> --status <online|attention|offline> [--label "..."] [--detail "..."] [--activity true]
  heartbeat-agent --agent <noah|carmen> [--status <online|attention>] [--detail "..."] [--activity true]
  pulse-agent --agent <noah|carmen> [--status <online|attention>] [--detail "..."]
  set-thread-name --thread <conversation-id> --label "Kurzname"
  set-thread --thread <conversation-id> [--status <running|needs_input|error|done>] [--label "..."] [--detail "..."] [--slot <1-4>] [--exit-code 1]
  heartbeat-thread --thread <conversation-id> [--label "..."] [--detail "..."] [--slot <1-4>]
  clear-thread --thread <conversation-id>
  heartbeat --slot <1-4>
  start --slot <1-4> --label "Build" --command "npm run build"

API:
  GET  /health
  GET  /state
  GET  /slots
  GET  /agents
  GET  /threads
  POST /slots/:slot
  POST /agents/:name
  POST /threads/:threadId
  POST /threads/:threadId/heartbeat
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
    startedAt: nowIso(),
    threadOrTaskId,
    exitCode: null,
    pid: child.pid,
    heartbeatAt: nowIso(),
    source: "manual"
  });

  const heartbeat = setInterval(() => {
    updateSlot(slot, {
      status: "running",
      detail: "Laeuft",
      startedAt: null,
      pid: child.pid,
      heartbeatAt: nowIso(),
      source: "manual"
    }).catch(() => {});
  }, 5_000);

  child.on("exit", async code => {
    clearInterval(heartbeat);
    await updateSlot(slot, {
      status: code === 0 ? "done" : "error",
      detail: code === 0 ? "Erfolgreich beendet" : `Mit Fehler beendet (${code ?? 1})`,
      startedAt: null,
      exitCode: code ?? 1,
      pid: null,
      heartbeatAt: null,
      source: "manual"
    });
  });

  child.on("error", async error => {
    clearInterval(heartbeat);
    await updateSlot(slot, {
      status: "error",
      detail: `Startfehler: ${error.message}`,
      startedAt: null,
      exitCode: 1,
      pid: null,
      heartbeatAt: null,
      source: "manual"
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
        sendJson(res, 200, { ok: true, port: PORT, dataFile: DATA_FILE, threadsFile: THREADS_FILE });
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        sendJson(res, 200, { slots: await loadEffectiveSlots(), agents: await loadEffectiveAgents(), threads: await loadExplicitThreads() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/slots") {
        sendJson(res, 200, await loadEffectiveSlots());
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents") {
        sendJson(res, 200, await loadEffectiveAgents());
        return;
      }

      if (req.method === "GET" && url.pathname === "/threads") {
        sendJson(res, 200, await loadExplicitThreads());
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
          startedAt: body.status === "running" && body.startedAt !== null ? body.startedAt ?? nowIso() : body.startedAt ?? undefined,
          threadOrTaskId: body.threadOrTaskId,
          exitCode: body.exitCode,
          pid: body.pid,
          heartbeatAt: body.status === "running" ? nowIso() : body.heartbeatAt ?? null,
          source: "manual"
        });
        sendJson(res, 200, updated);
        return;
      }

      const agentMatch = url.pathname.match(/^\/agents\/([a-z]+)$/);
      if (req.method === "POST" && agentMatch) {
        const body = await parseBody(req);
        const normalizedStatus = body.status !== undefined ? normalizeAgentStatus(body.status) : undefined;
        const activity = parseBooleanFlag(body.activity, false);
        const updated = await updateAgent(agentMatch[1], {
          label: body.label,
          status: normalizedStatus,
          detail: body.detail,
          lastSeenAt: normalizedStatus && normalizedStatus !== "offline" ? nowIso() : body.lastSeenAt ?? undefined,
          heartbeatAt: normalizedStatus && normalizedStatus !== "offline" ? nowIso() : body.heartbeatAt ?? undefined,
          activity,
          blinkUntil:
            body.blinkUntil !== undefined
              ? body.blinkUntil
              : activity || normalizedStatus === "attention"
                ? futureIso(15_000)
                : normalizedStatus === "offline"
                  ? null
                  : undefined
        });
        sendJson(res, 200, updated);
        return;
      }

      const threadHeartbeatMatch = url.pathname.match(/^\/threads\/([^/]+)\/heartbeat$/);
      if (req.method === "POST" && threadHeartbeatMatch) {
        const body = await parseBody(req);
        const updated = await updateThread(decodeURIComponent(threadHeartbeatMatch[1]), {
          label: body.label,
          detail: body.detail,
          slot: body.slot,
          status: body.status ?? "running",
          startedAt: body.startedAt ?? undefined,
          heartbeatAt: nowIso(),
          source: body.source || "codex-app"
        });
        sendJson(res, 200, updated);
        return;
      }

      const threadMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
      if (req.method === "POST" && threadMatch) {
        const body = await parseBody(req);
        const updated = await updateThread(decodeURIComponent(threadMatch[1]), {
          label: body.label,
          status: body.status,
          detail: body.detail,
          slot: body.slot,
          startedAt:
            body.status === "running" && body.startedAt !== null ? body.startedAt ?? nowIso() : body.startedAt ?? undefined,
          heartbeatAt:
            body.heartbeat === true || body.status === "running"
              ? nowIso()
              : body.heartbeatAt ?? undefined,
          finishedAt:
            body.status === "done" || body.status === "error"
              ? body.finishedAt ?? nowIso()
              : body.finishedAt ?? undefined,
          exitCode: body.exitCode,
          source: body.source || "codex-app",
          clear: body.clear === true
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
    case "threads":
      console.log(JSON.stringify(await loadExplicitThreads(), null, 2));
      return;
    case "state":
      console.log(JSON.stringify({ slots: await loadEffectiveSlots(), agents: await loadEffectiveAgents(), threads: await loadExplicitThreads() }, null, 2));
      return;
    case "clear": {
      const slot = normalizeSlot(args.slot);
      console.log(JSON.stringify(await updateSlot(slot, createDefaultSlot(slot)), null, 2));
      return;
    }
    case "heartbeat": {
      const slot = normalizeSlot(args.slot);
      console.log(JSON.stringify(await updateSlot(slot, { heartbeatAt: nowIso(), status: "running", source: "manual" }), null, 2));
      return;
    }
    case "set-status": {
      const slot = normalizeSlot(args.slot);
      const patch = {
        label: args.label,
        status: normalizeStatus(String(args.status)),
        detail: args.detail,
        startedAt: args.status === "running" ? nowIso() : null,
        threadOrTaskId: args.thread,
        exitCode: args["exit-code"],
        pid: args.pid,
        heartbeatAt: args.status === "running" ? nowIso() : null,
        source: "manual"
      };
      console.log(JSON.stringify(await updateSlot(slot, patch), null, 2));
      return;
    }
    case "set-agent": {
      const agent = normalizeAgentName(args.agent);
      const status = normalizeAgentStatus(String(args.status));
      const activity = parseBooleanFlag(args.activity, false);
      const patch = {
        label: args.label,
        status,
        detail: args.detail,
        lastSeenAt: status !== "offline" ? nowIso() : null,
        heartbeatAt: status !== "offline" ? nowIso() : null,
        activity,
        blinkUntil: activity || status === "attention" ? futureIso(15_000) : null
      };
      console.log(JSON.stringify(await updateAgent(agent, patch), null, 2));
      return;
    }
    case "heartbeat-agent": {
      const agent = normalizeAgentName(args.agent);
      const status = args.status ? normalizeAgentStatus(String(args.status)) : "online";
      const activity = parseBooleanFlag(args.activity, false);
      console.log(
        JSON.stringify(
          await updateAgent(agent, {
            status,
            detail: args.detail,
            lastSeenAt: nowIso(),
            heartbeatAt: nowIso(),
            activity,
            blinkUntil: activity || status === "attention" ? futureIso(15_000) : null
          }),
          null,
          2
        )
      );
      return;
    }
    case "pulse-agent": {
      const agent = normalizeAgentName(args.agent);
      const status = args.status ? normalizeAgentStatus(String(args.status)) : undefined;
      console.log(
        JSON.stringify(
          await updateAgent(agent, {
            status,
            detail: args.detail,
            lastSeenAt: status && status !== "offline" ? nowIso() : undefined,
            heartbeatAt: status && status !== "offline" ? nowIso() : undefined,
            blinkUntil: futureIso(15_000)
          }),
          null,
          2
        )
      );
      return;
    }
    case "set-thread-name": {
      console.log(JSON.stringify(await setThreadName(args.thread, args.label), null, 2));
      return;
    }
    case "set-thread": {
      const status = args.status !== undefined ? normalizeStatus(String(args.status)) : undefined;
      console.log(
        JSON.stringify(
          await updateThread(args.thread, {
            label: args.label,
            status,
            detail: args.detail,
            slot: args.slot,
            startedAt: status === "running" ? nowIso() : undefined,
            heartbeatAt: status === "running" ? nowIso() : undefined,
            finishedAt: status === "done" || status === "error" ? nowIso() : undefined,
            exitCode: args["exit-code"],
            source: "codex-app"
          }),
          null,
          2
        )
      );
      return;
    }
    case "heartbeat-thread": {
      console.log(
        JSON.stringify(
          await updateThread(args.thread, {
            label: args.label,
            detail: args.detail,
            slot: args.slot,
            status: "running",
            heartbeatAt: nowIso(),
            source: "codex-app"
          }),
          null,
          2
        )
      );
      return;
    }
    case "clear-thread": {
      console.log(JSON.stringify(await clearThread(args.thread), null, 2));
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
