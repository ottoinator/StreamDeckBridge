import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const HEARTBEAT_TIMEOUT_MS = 30_000;
const ENABLE_PROCESS_AUTODETECT = process.env.CODEX_MONITOR_AUTODETECT_PROCESSES === "1";
const VALID_STATUSES = new Set(["idle", "running", "needs_input", "error", "done"]);
const VALID_AGENT_STATUSES = new Set(["online", "attention", "offline"]);
const AGENT_ORDER = ["noah", "carmen"];
const execFileAsync = promisify(execFile);
const AGENT_HEARTBEAT_TIMEOUT_MS = 90_000;
const AGENT_PROBE_TTL_MS = 15_000;
const NOAH_MONITOR_TTL_MS = 15_000;
const PUSH_ONLY_AGENT_STATES = !["0", "false", "no", "off"].includes(String(process.env.CODEX_MONITOR_AGENT_PUSH_ONLY || "1").trim().toLowerCase());
const AGENT_PUSH_TOKEN = String(process.env.CODEX_MONITOR_AGENT_PUSH_TOKEN || "").trim();
const THREAD_HEARTBEAT_TIMEOUT_MS = Number(process.env.CODEX_MONITOR_THREAD_HEARTBEAT_TIMEOUT_MS || 180_000);
const THREAD_DONE_TTL_MS = Number(process.env.CODEX_MONITOR_THREAD_DONE_TTL_MS || 900_000);
const THREAD_NEEDS_INPUT_TTL_MS = Number(process.env.CODEX_MONITOR_THREAD_NEEDS_INPUT_TTL_MS || 86_400_000);
const AGENT_ACTIVITY_WINDOW_MS = 600_000;
const ENABLE_REMOTE_AGENT_ACTIVITY = process.env.CODEX_MONITOR_REMOTE_AGENT_ACTIVITY === "1";
const NOAH_TILE_ORDER = ["xetra_status", "xetra_cycle", "us_status", "us_cycle"];
const STATE_STREAM_HEARTBEAT_MS = 15_000;
const stateStreamClients = new Set();
function parseOptionalNumber(value, fallback = undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAgentRemoteHeaders(prefix) {
  const headers = {};
  const bearerToken = process.env[`${prefix}_STATUS_BEARER_TOKEN`];
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const headerName = process.env[`${prefix}_STATUS_HEADER_NAME`];
  const headerValue = process.env[`${prefix}_STATUS_HEADER_VALUE`];
  if (headerName && headerValue) {
    headers[headerName] = headerValue;
  }
  return headers;
}

function createAgentRemoteConfig(prefix, sshHostEnv, defaultHost, commandEnv, defaultCommand) {
  const statusUrl = process.env[`${prefix}_STATUS_URL`];
  if (statusUrl) {
    return {
      kind: "http-json",
      url: statusUrl,
      headers: buildAgentRemoteHeaders(prefix),
      timeoutMs: parseOptionalNumber(process.env[`${prefix}_STATUS_TIMEOUT_MS`], 4_000)
    };
  }

  return {
    kind: "ssh-json",
    host: process.env[sshHostEnv] || defaultHost,
    command: process.env[commandEnv] || defaultCommand,
    timeoutMs: parseOptionalNumber(process.env[`${prefix}_STATUS_TIMEOUT_MS`], 8_000)
  };
}

const AGENT_REMOTE_DEFAULTS = {
  noah: createAgentRemoteConfig(
    "CODEX_MONITOR_NOAH",
    "CODEX_MONITOR_NOAH_SSH_HOST",
    "ocvps",
    "CODEX_MONITOR_NOAH_STATUS_COMMAND",
    (
      "python3 - <<'PY'\nfrom pathlib import Path\nimport json\nbase=Path('/root/.openclaw/workspace/.pi')\nfiles={\n  'paper_cycle': base/'paper_cycle.log.jsonl',\n  'main_bundle': base/'artifacts'/'noah3'/'main_decision_bundle.json',\n  'companion_log': base/'companion_api.log',\n  'companion_access_log': base/'companion_api_access.log.jsonl',\n  'owner_health_alert_state': base/'owner_health_alert_state.json',\n  'main_sessions': Path('/root/.openclaw/agents/main/sessions')/'sessions.json',\n}\nout={}\nfor key, path in files.items():\n    out[key]={'exists': path.exists(), 'mtime': path.stat().st_mtime if path.exists() else None}\nlatest_session=None\nsessions_dir=Path('/root/.openclaw/agents/main/sessions')\nif sessions_dir.exists():\n    files=sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session={'exists': True, 'mtime': files[0].stat().st_mtime, 'name': files[0].name}\nout['latest_session']=latest_session\nprint(json.dumps(out))\nPY"
    )
  ),
  carmen: createAgentRemoteConfig(
    "CODEX_MONITOR_CARMEN",
    "CODEX_MONITOR_CARMEN_SSH_HOST",
    "carmen-vps",
    "CODEX_MONITOR_CARMEN_STATUS_COMMAND",
    (
      "python3 - <<'PY'\nfrom pathlib import Path\nimport json, subprocess\nstatus = json.loads(subprocess.check_output(['python3','/root/.openclaw/workspace/integrations/whatsapp/vnext_status.py'], text=True))\nsessions_dir = Path('/root/.openclaw/agents/main/sessions')\nlatest_session_mtime = None\nlatest_session_file = None\nif sessions_dir.exists():\n    files = sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session_file = files[0].name\n        latest_session_mtime = files[0].stat().st_mtime\nroots = [\n    Path('/root/.openclaw/workspace/integrations/whatsapp/logs'),\n    Path('/root/.openclaw/workspace/integrations/whatsapp/state'),\n    Path('/root/.openclaw/agents/main/sessions'),\n]\nrecent_mtime = None\nrecent_file = None\nfor root in roots:\n    if not root.exists():\n        continue\n    for candidate in root.rglob('*'):\n        try:\n            if not candidate.is_file():\n                continue\n            mtime = candidate.stat().st_mtime\n        except Exception:\n            continue\n        if recent_mtime is None or mtime > recent_mtime:\n            recent_mtime = mtime\n            recent_file = str(candidate)\nstatus['mainSessions'] = {'latestFile': latest_session_file, 'latestMtime': latest_session_mtime}\nstatus['activityFiles'] = {'latestFile': recent_file, 'latestMtime': recent_mtime}\nprint(json.dumps(status))\nPY"
    )
  )
};
const agentProbeCache = new Map();
const agentProbeInflight = new Map();
const noahMonitorCache = {
  cachedAt: 0,
  result: null,
  lastGoodResult: null
};
let noahMonitorInflight = null;
const NOAH_MONITOR_DEFAULTS = {
  host: process.env.CODEX_MONITOR_NOAH_SSH_HOST || (AGENT_REMOTE_DEFAULTS.noah.kind === "ssh-json" ? AGENT_REMOTE_DEFAULTS.noah.host : "ocvps"),
  command:
    process.env.CODEX_MONITOR_NOAH_MONITOR_COMMAND ||
    String.raw`python3 - <<'PY'
import json,subprocess,urllib.request
from datetime import datetime,time,timedelta,timezone
from pathlib import Path
from zoneinfo import ZoneInfo
B=Path('/root/.openclaw/workspace/.pi');R=B/'artifacts'/'xetra_behavior_smoke_registry.json'
def p(v):
    try:return datetime.fromisoformat(str(v)) if v else None
    except Exception:return None
def iso(v): return v.isoformat() if v else None
def r(x):
    try:return json.loads(Path(x).read_text(encoding='utf-8')) if x and Path(x).exists() else None
    except Exception:return None
def jl(x):
    if not x or not Path(x).exists(): return None
    last=None
    try:
        for line in Path(x).open('r',encoding='utf-8'):
            line=line.strip()
            if line: last=json.loads(line)
    except Exception:return None
    return last
def tok():
    try:s=subprocess.check_output(['systemctl','cat','noah_companion_api.service'],text=True)
    except Exception:return None
    for line in s.splitlines():
        if line.startswith('Environment=NOAH_COMPANION_API_TOKEN='): return line.split('=',2)[2].strip()
def get(path,t):
    h={'Accept':'application/json'}
    if t: h['Authorization']='Bearer '+t
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765'+path,headers=h),timeout=6) as y: return json.load(y)
def safe(path,t):
    try:return get(path,t),None
    except Exception as e:return None,str(e)
def nxt(now):
    et=ZoneInfo('America/New_York'); de=ZoneInfo('Europe/Berlin'); now=now.astimezone(et); d=now.date()
    while True:
        c=datetime.combine(d,time(9,30),tzinfo=et)
        if c.weekday()<5 and c>now: return c.astimezone(de)
        d+=timedelta(days=1)
def sump(o,k):
    n=0
    for v in (o or {}).values():
        try:n+=int((v or {}).get(k) or 0)
        except Exception:pass
    return n
def opn(o):
    n=0
    for v in (o or {}).values():
        x=(v or {}).get('open_positions')
        if isinstance(x,dict): n+=len(x)
        else:
            try:n+=int(x or 0)
            except Exception:pass
    return n
def xs():
    reg=r(R) or {}; a=reg.get('active_run') or {}; s=reg.get('scheduled_run') or {}; l=reg.get('last_run') or {}; st=None
    for c in (a,s,l):
        st=r(c.get('status_path'))
        if st: break
    if not st:
        e=(reg.get('runs_by_trade_day') or {}).get((a or s or l or {}).get('trade_day') or '')
        st=((e or {}).get('status')) or {}
    iv=a.get('interval_sec') or s.get('interval_sec') or 300; lc=p(st.get('latest_cycle_ts_et')); nc=lc+timedelta(seconds=int(iv)) if lc else None
    bd=Path(a.get('base_dir') or s.get('base_dir') or l.get('base_dir') or st.get('base_dir') or B)
    ps=r(bd/'paper_state.json') or {}; cy=jl(bd/'paper_cycle.log.jsonl') or {}
    return {'state':st.get('state') or a.get('state') or s.get('state') or l.get('state') or 'not_started','trade_day':st.get('trade_day') or a.get('trade_day') or s.get('trade_day') or l.get('trade_day'),'cycle_count':int(st.get('cycle_count') or 0),'roundtrip_count':int(st.get('roundtrip_count') or 0),'open_positions':opn((ps.get('policies') or (cy.get('policies') or {}))),'closed_positions':int(st.get('roundtrip_count') or 0),'latest_cycle_at':iso(lc),'next_cycle_at':iso(nc),'scheduled_start_at':iso(p(a.get('scheduled_start_berlin') or s.get('scheduled_start_berlin') or st.get('scheduled_start_berlin'))),'session_window':st.get('session_window'),'interval_sec':int(iv),'source':'registry'}
def us(now,st,it,cy):
    rows=(cy or {}).get('cycles') or []; lc=p((((st or {}).get('system_health') or {}).get('last_successful_cycle_ts_et')) or ((rows[-1] if rows else {}).get('ts_et'))); pc=p((rows[-2] if len(rows)>=2 else {}).get('ts_et')); iv=int((lc-pc).total_seconds()) if lc and pc else 600
    if iv<=0: iv=600
    ss=(((st or {}).get('trading_posture') or {}).get('session_state') or {}); pm=((it or {}).get('current_policy_metrics') or {}); ts=((it or {}).get('decision_trail_summary') or {}); rt=len(ts.get('roundtrips') or [])
    mk=bool((it or {}).get('market_open')) or ss.get('code') in ('TRADEABLE','DEFENSIVE','CLOSE_ONLY')
    return {'trade_day':(it or {}).get('trade_day') or (cy or {}).get('trade_day'),'market_open':mk,'session_state':ss.get('code'),'session_subtitle':ss.get('subtitle'),'headline':(((st or {}).get('human_status') or {}).get('headline')),'health':((((st or {}).get('system_health') or {}).get('status') or {}).get('code')),'last_cycle_at':iso(lc),'next_cycle_at':iso(lc+timedelta(seconds=iv) if lc else None),'cycle_interval_sec':iv,'roundtrip_count':rt,'open_positions':sump(pm,'open_positions'),'closed_positions':max(rt,sump(ts.get('policy_summary') or {},'positions_closed'),sump(pm,'exits_today')),'entries_today':sump(pm,'entries_today'),'trade_ideas_count':int((it or {}).get('trade_ideas_count') or 0),'next_market_open_berlin':iso(nxt(now))}
t=tok(); now=datetime.now(timezone.utc); st,se=safe('/api/v1/status/current',t); it,ie=safe('/api/v1/intraday/today',t); cy,ce=safe('/api/v1/observer/cycles?limit=3',t)
out={'checked_at':datetime.now(timezone.utc).isoformat(),'us':us(now,st,it,cy),'xetra':xs()}; w={k:v for k,v in {'status_current':se,'intraday_today':ie,'observer_cycles':ce}.items() if v}
if w: out['warnings']=w
print(json.dumps(out))
PY`
};

function nowIso() {
  return new Date().toISOString();
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
    const isReactivation = status === "running" && thread.status !== "running";
    next.status = status;
    if (status === "running") {
      next.startedAt = patch.startedAt || (isReactivation ? nowIso() : thread.startedAt || nowIso());
      next.finishedAt = null;
      next.heartbeatAt = patch.heartbeatAt || nowIso();
      if (patch.detail === undefined && isReactivation) {
        next.detail = "Aktiver Thread";
      }
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

function getThreadBaseLabel(thread, threadNames) {
  return thread.label || String(threadNames[thread.threadId] || "").trim() || `Chat ${thread.slot}`;
}

function getShortThreadToken(threadId) {
  const firstSegment = String(threadId || "").split("-")[0] || String(threadId || "");
  const alnum = firstSegment.replace(/[^a-zA-Z0-9]/g, "");
  return (alnum.slice(-4) || String(threadId || "").slice(-4) || "CHAT").toUpperCase();
}

function threadToSlotState(thread, threadNames, displayLabel = "") {
  return {
    slot: thread.slot,
    label: displayLabel || getThreadBaseLabel(thread, threadNames),
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

function buildExplicitThreadSlotStates(threads, threadNames) {
  const visibleThreads = threads.filter(thread => thread.slot !== null);
  const labelCounts = new Map();

  for (const thread of visibleThreads) {
    const baseLabel = getThreadBaseLabel(thread, threadNames);
    const key = baseLabel.trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }

  return visibleThreads
    .map(thread => {
      const baseLabel = getThreadBaseLabel(thread, threadNames);
      const key = baseLabel.trim().toLowerCase();
      const duplicateCount = labelCounts.get(key) || 0;
      const displayLabel = duplicateCount > 1 ? `Chat ${getShortThreadToken(thread.threadId)}` : baseLabel;
      return threadToSlotState(thread, threadNames, displayLabel);
    })
    .sort((left, right) => left.slot - right.slot);
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

async function loadEffectiveSlots() {
  const storedSlots = withHeartbeatTimeout(await readSlots());
  const cleanedSlots = storedSlots.map(slot => {
    const isEphemeralSource = slot.source === "process";
    const isLegacyProcessOverlay =
      slot.autodetected ||
      (String(slot.detail || "") === "Codex aktiv" && /^Codex (Desktop|Service)/.test(String(slot.label || "")));

    if (!isEphemeralSource && !isLegacyProcessOverlay) {
      return slot;
    }

    return createDefaultSlot(slot.slot);
  });

  if (JSON.stringify(cleanedSlots) !== JSON.stringify(storedSlots)) {
    await writeSlots(cleanedSlots);
  }

  const threadNames = await readThreadNames();
  const explicitThreads = await loadExplicitThreads();
  const explicitThreadSlots = buildExplicitThreadSlotStates(explicitThreads, threadNames);
  const withExplicitThreads = overlayExplicitThreads(cleanedSlots, explicitThreadSlots);
  if (!ENABLE_PROCESS_AUTODETECT) {
    return withExplicitThreads;
  }
  const discoveredProcesses = await discoverCodexProcesses();
  return overlayDiscoveredProcesses(withExplicitThreads, discoveredProcesses);
}

async function loadEffectiveAgents() {
  const agents = await readAgents();
  const now = Date.now();
  const heartbeatNormalized = agents.map(agent => {
    const lastSeenAgeMs = agent.lastSeenAt ? now - Date.parse(agent.lastSeenAt) : Number.NaN;
    const pushGapDetail = Number.isFinite(lastSeenAgeMs)
      ? `Push unterbrochen seit ${formatAgeCompact(lastSeenAgeMs)} (letztes Signal ${formatLocalClock(agent.lastSeenAt)})`
      : "Warte auf Push";
    if (PUSH_ONLY_AGENT_STATES && !agent.heartbeatAt) {
      if (agent.status === "offline" || agent.status === "online") {
        return applyAgentPatch(agent, {
          status: "attention",
          detail: pushGapDetail,
          activity: false,
          blinkUntil: null
        });
      }
      return agent;
    }
    if (agent.status === "offline" || !agent.heartbeatAt) {
      return agent;
    }
    const age = now - Date.parse(agent.heartbeatAt);
    if (Number.isNaN(age) || age <= AGENT_HEARTBEAT_TIMEOUT_MS) {
      return agent;
    }
    if (PUSH_ONLY_AGENT_STATES) {
      return applyAgentPatch(agent, {
        status: "attention",
        detail: pushGapDetail,
        activity: false,
        heartbeatAt: null,
        blinkUntil: null
      });
    }
    return applyAgentPatch(agent, {
      status: "offline",
      detail: "Kein Signal",
      activity: false,
      heartbeatAt: null,
      blinkUntil: null
    });
  });
  if (PUSH_ONLY_AGENT_STATES) {
    await writeAgents(heartbeatNormalized);
    return heartbeatNormalized;
  }
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

function formatLocalClock(value) {
  if (!value) {
    return "--:--";
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin"
  }).format(new Date(parsed));
}

function formatAgeCompact(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(remSeconds).padStart(2, "0")}s`;
  }
  return `${remSeconds}s`;
}

async function fetchJson(url, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || 4_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function runSshJson(host, command, timeout = 8_000) {
  const { stdout } = await execFileAsync(
    "ssh",
    [host, command],
    {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
  );
  const output = String(stdout || "").trim();
  return output ? JSON.parse(output) : {};
}

async function runRemoteProbe(config) {
  if (config?.kind === "http-json") {
    return fetchJson(config.url, {
      headers: config.headers,
      timeoutMs: config.timeoutMs
    });
  }
  return runSshJson(config.host, config.command, config.timeoutMs);
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

function getValueAtPath(payload, pathExpression) {
  return String(pathExpression)
    .split(".")
    .reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), payload);
}

function firstPresentValue(payload, paths) {
  for (const pathExpression of paths) {
    const value = getValueAtPath(payload, pathExpression);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function firstFiniteNumber(payload, paths) {
  for (const pathExpression of paths) {
    const value = firstPresentValue(payload, [pathExpression]);
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function firstBooleanValue(payload, paths) {
  for (const pathExpression of paths) {
    const value = firstPresentValue(payload, [pathExpression]);
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string" || typeof value === "number") {
      return parseBooleanFlag(value, undefined);
    }
  }
  return undefined;
}

function firstStringValue(payload, paths) {
  const value = firstPresentValue(payload, paths);
  return value !== undefined ? String(value) : undefined;
}

function formatTokenCount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "";
  }
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(amount));
}

function deriveOpenAiActivity(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const totalTokens = firstFiniteNumber(payload, [
    "activity.totalTokens",
    "openai.totalTokens",
    "openai.tokens.total",
    "openai.usage.total_tokens",
    "usage.total_tokens",
    "tokens.total"
  ]);
  const windowTokens = firstFiniteNumber(payload, [
    "activity.windowTokens",
    "openai.windowTokens",
    "openai.window.tokens",
    "openai.window.total_tokens",
    "usage.window.total_tokens",
    "tokens.window.total"
  ]);
  const windowMinutes = firstFiniteNumber(payload, [
    "activity.windowMinutes",
    "openai.windowMinutes",
    "openai.window.minutes",
    "usage.window.minutes",
    "tokens.window.minutes"
  ]) || 5;
  const lastActivityAt = firstStringValue(payload, [
    "activity.lastActivityAt",
    "openai.lastActivityAt",
    "openai.last_activity_at",
    "usage.last_activity_at",
    "lastActivityAt"
  ]);
  const recentActivity = firstBooleanValue(payload, [
    "recentActivity",
    "activity.recentActivity",
    "openai.recentActivity"
  ]);
  const activityMetric =
    firstStringValue(payload, ["activityMetric", "activity.metric", "openai.activityMetric"]) ||
    (Number.isFinite(totalTokens)
      ? `tokens:${Math.trunc(totalTokens)}`
      : Number.isFinite(windowTokens)
        ? `window:${Math.trunc(windowTokens)}:${lastActivityAt || ""}`
        : lastActivityAt
          ? `activity:${lastActivityAt}`
          : undefined);
  const detail =
    firstStringValue(payload, ["detail", "activity.detail", "openai.detail"]) ||
    (Number.isFinite(windowTokens) && windowTokens > 0
      ? `OpenAI ${formatTokenCount(windowTokens)} Tok/${windowMinutes}m`
      : Number.isFinite(totalTokens)
        ? `OpenAI ${formatTokenCount(totalTokens)} Tok ges.`
        : undefined);

  if (!detail && recentActivity === undefined && activityMetric === undefined) {
    return null;
  }

  return {
    detail,
    recentActivity:
      recentActivity !== undefined
        ? recentActivity
        : Number.isFinite(windowTokens)
          ? windowTokens > 0
          : lastActivityAt
            ? isRecentIsoTimestamp(lastActivityAt, AGENT_ACTIVITY_WINDOW_MS)
            : undefined,
    activityMetric,
    allowRemoteActivity: true
  };
}

function makeExplicitProbeResult(payload, fallbackStatus, fallbackDetail) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const explicitStatus = payload.status !== undefined ? normalizeAgentStatus(payload.status) : fallbackStatus;
  const explicitDetail = firstStringValue(payload, ["detail"]);
  const explicitRecentActivity = firstBooleanValue(payload, ["recentActivity"]);
  const explicitActivityMetric = firstStringValue(payload, ["activityMetric"]);
  const openAiActivity = deriveOpenAiActivity(payload);

  const hasExplicitSignal =
    payload.status !== undefined ||
    explicitDetail !== undefined ||
    explicitRecentActivity !== undefined ||
    explicitActivityMetric !== undefined ||
    Boolean(openAiActivity);

  if (!hasExplicitSignal) {
    return null;
  }

  return makeProbeResult(explicitStatus, explicitDetail || openAiActivity?.detail || fallbackDetail, {
    recentActivity: explicitRecentActivity ?? openAiActivity?.recentActivity,
    activityMetric: explicitActivityMetric || openAiActivity?.activityMetric,
    allowRemoteActivity: openAiActivity?.allowRemoteActivity || explicitRecentActivity !== undefined || explicitActivityMetric !== undefined
  });
}

async function probeNoahRemote() {
  try {
    const payload = await runRemoteProbe(AGENT_REMOTE_DEFAULTS.noah);
    const explicit = makeExplicitProbeResult(payload, "online", "VPS erreichbar");
    if (explicit) {
      return explicit;
    }
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
    const payload = await runRemoteProbe(AGENT_REMOTE_DEFAULTS.carmen);
    const explicit = makeExplicitProbeResult(payload, "online", "VPS erreichbar");
    if (explicit) {
      return explicit;
    }
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
    const remoteActivityEnabled = probe.allowRemoteActivity || ENABLE_REMOTE_AGENT_ACTIVITY;
    const changedActivityMetric =
      remoteActivityEnabled &&
      probe.activityMetric !== undefined &&
      previous?.activityMetric !== undefined &&
      probe.activityMetric !== previous.activityMetric;
    const shouldBlink =
      remoteActivityEnabled &&
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

function formatBerlinTime(value) {
  if (!value) {
    return "--:--";
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin"
  }).format(new Date(parsed));
}

function formatCountdown(target) {
  if (!target) {
    return "--:--";
  }
  const parsed = Date.parse(String(target));
  if (Number.isNaN(parsed)) {
    return "--:--";
  }
  const diffSeconds = Math.max(0, Math.floor((parsed - Date.now()) / 1000));
  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateInZone(value, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

function normalizeTradeDay(value) {
  if (!value) {
    return "";
  }
  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return "";
  }
  return formatDateInZone(new Date(parsed), "UTC");
}

function isSameTradeDayInZone(value, timeZone, now = new Date()) {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return false;
  }
  return formatDateInZone(new Date(parsed), timeZone) === formatDateInZone(now, timeZone);
}

function nextBerlinWeekdayTime(hour, minute, now = new Date()) {
  const berlinNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const candidate = new Date(berlinNow);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate <= berlinNow) {
    candidate.setDate(candidate.getDate() + 1);
  }
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() + 1);
  }
  const deltaMs = candidate.getTime() - berlinNow.getTime();
  return new Date(now.getTime() + deltaMs).toISOString();
}

function titleCaseValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatUsSessionLabel(value, marketOpen) {
  if (marketOpen) {
    return "Laeuft";
  }
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "OPEN_DISCOVERY") {
    return "Vorstart";
  }
  if (normalized === "TRADEABLE") {
    return "Handel";
  }
  if (normalized === "DEFENSIVE") {
    return "Defensiv";
  }
  if (normalized === "NO_TRADE_LOCK") {
    return "Gesperrt";
  }
  if (normalized === "CLOSE_ONLY") {
    return "Nur Exit";
  }
  return titleCaseValue(value || "wartet");
}

function createDefaultNoahTile(key) {
  const labels = {
    xetra_status: "Xetra",
    xetra_cycle: "Xetra Zyklus",
    us_status: "US Handel",
    us_cycle: "US Zyklus"
  };
  return {
    key,
    label: labels[key] || "Noah",
    status: "idle",
    line1: "Keine Daten",
    line2: "Warte auf Probe",
    footer: "--:--",
    updatedAt: nowIso()
  };
}

function formatTradeCountLine(label, value) {
  return `${label} ${Number(value || 0)}`;
}

function makeNoahProbeFallback(message) {
  return {
    checked_at: nowIso(),
    error: String(message || "Noah Monitor nicht verfuegbar"),
    us: null,
    xetra: null
  };
}

function hasUsableNoahSummary(summary) {
  if (!summary || summary.error) {
    return false;
  }
  return Boolean(summary.us || summary.xetra);
}

function buildStaleNoahSummary(previous, message) {
  return {
    ...previous,
    checked_at: nowIso(),
    stale_reason: String(message || "Noah Monitor nicht verfuegbar")
  };
}

async function probeNoahMonitor() {
  try {
    return await runSshJson(NOAH_MONITOR_DEFAULTS.host, NOAH_MONITOR_DEFAULTS.command, 45_000);
  } catch (error) {
    return makeNoahProbeFallback(error instanceof Error ? error.message : String(error));
  }
}

async function getCachedNoahMonitor() {
  if (noahMonitorCache.result && Date.now() - noahMonitorCache.cachedAt <= NOAH_MONITOR_TTL_MS) {
    return noahMonitorCache.result;
  }

  if (noahMonitorInflight) {
    return noahMonitorInflight;
  }

  noahMonitorInflight = probeNoahMonitor()
    .then(result => {
      const usableResult =
        result?.error && noahMonitorCache.lastGoodResult
          ? buildStaleNoahSummary(noahMonitorCache.lastGoodResult, result.error)
          : result;
      noahMonitorCache.cachedAt = Date.now();
      noahMonitorCache.result = usableResult;
      if (hasUsableNoahSummary(usableResult)) {
        noahMonitorCache.lastGoodResult = usableResult;
      }
      noahMonitorInflight = null;
      return usableResult;
    })
    .catch(error => {
      const fallback = noahMonitorCache.lastGoodResult
        ? buildStaleNoahSummary(noahMonitorCache.lastGoodResult, error instanceof Error ? error.message : String(error))
        : makeNoahProbeFallback(error instanceof Error ? error.message : String(error));
      noahMonitorCache.cachedAt = Date.now();
      noahMonitorCache.result = fallback;
      noahMonitorInflight = null;
      return fallback;
    });

  return noahMonitorInflight;
}

function refreshNoahMonitorInBackground() {
  if (noahMonitorInflight) {
    return;
  }
  if (noahMonitorCache.result && Date.now() - noahMonitorCache.cachedAt <= NOAH_MONITOR_TTL_MS) {
    return;
  }
  void getCachedNoahMonitor()
    .then(() => broadcastStateStream().catch(() => {}))
    .catch(() => {});
}

function getImmediateNoahMonitor() {
  refreshNoahMonitorInBackground();
  return noahMonitorCache.result || makeNoahProbeFallback("Warte auf Probe");
}

function buildNoahTiles(summary) {
  const now = new Date();
  const updatedAt = summary?.checked_at || nowIso();
  if (summary?.error) {
    const xetraStartAt = nextBerlinWeekdayTime(9, 0, now);
    const usStartAt = nextBerlinWeekdayTime(15, 30, now);
    const fallbackTiles = {
      xetra_status: {
        key: "xetra_status",
        label: "Xetra",
        status: "idle",
        line1: `Start ${formatBerlinTime(xetraStartAt)}`,
        line2: formatCountdown(xetraStartAt),
        footer: "Warte auf Daten",
        updatedAt
      },
      xetra_cycle: {
        key: "xetra_cycle",
        label: "Xetra Zyklus",
        status: "idle",
        line1: `Start ${formatBerlinTime(xetraStartAt)}`,
        line2: formatCountdown(xetraStartAt),
        footer: "Warte auf Daten",
        updatedAt
      },
      us_status: {
        key: "us_status",
        label: "US Handel",
        status: "idle",
        line1: `Start ${formatBerlinTime(usStartAt)}`,
        line2: formatCountdown(usStartAt),
        footer: "Warte auf Daten",
        updatedAt
      },
      us_cycle: {
        key: "us_cycle",
        label: "US Zyklus",
        status: "idle",
        line1: `Start ${formatBerlinTime(usStartAt)}`,
        line2: formatCountdown(usStartAt),
        footer: "Warte auf Daten",
        updatedAt
      }
    };
    return NOAH_TILE_ORDER.map(key => ({
      ...createDefaultNoahTile(key),
      ...(fallbackTiles[key] || {})
    }));
  }

  const xetra = summary?.xetra || {};
  const us = summary?.us || {};
  const monitorDegraded = Boolean(summary?.stale_reason || Object.keys(summary?.warnings || {}).length);
  const tileStatus = status => (status === "error" ? "error" : monitorDegraded ? "warn" : status);
  const xetraState = String(xetra.state || "not_started").toLowerCase();
  const xetraOpenPositions = Number(xetra.open_positions || 0);
  const xetraClosedPositions = Number((xetra.closed_positions ?? xetra.roundtrip_count) || 0);
  const xetraStartAt = xetra.scheduled_start_at || nextBerlinWeekdayTime(9, 0, now);
  const xetraCycleToday = isSameTradeDayInZone(xetra.latest_cycle_at, "Europe/Berlin", now);
  const xetraTradeDayToday = normalizeTradeDay(xetra.trade_day) === formatDateInZone(now, "Europe/Berlin");
  const xetraRunning = xetraState === "running";
  const xetraPreOpen = !xetraRunning && !xetraCycleToday && !xetraTradeDayToday;
  const xetraStatus =
    xetraRunning
      ? "ok"
      : xetraPreOpen
        ? "idle"
      : ["planned", "starting", "stopping"].includes(xetraState)
        ? "warn"
        : ["failed", "error"].includes(xetraState)
          ? "error"
          : "idle";
  const usSession = String(us.session_state || "offline").toUpperCase();
  const usOpenPositions = Number(us.open_positions || 0);
  const usClosedPositions = Number((us.closed_positions ?? us.roundtrip_count) || 0);
  const usTradingActive = Boolean(us.market_open) || ["TRADEABLE", "DEFENSIVE", "CLOSE_ONLY"].includes(usSession);
  const usStartAt = us.next_market_open_berlin || nextBerlinWeekdayTime(15, 30, now);
  const usCycleToday = isSameTradeDayInZone(us.last_cycle_at, "America/New_York", now);
  const usTradeDayToday = normalizeTradeDay(us.trade_day) === formatDateInZone(now, "America/New_York");
  const usPreOpen = !usTradingActive && !usCycleToday && !usTradeDayToday;
  const usStatus =
    usTradingActive
      ? "ok"
      : usPreOpen
        ? "idle"
      : us.health === "INTERVENTION_REQUIRED"
        ? "error"
        : "warn";

  const xetraStatusFooter =
    xetraRunning
      ? "Laeuft"
      : xetraPreOpen
        ? `Start ${formatBerlinTime(xetraStartAt)}`
      : ["planned", "starting", "stopping"].includes(xetraState)
        ? `Start ${formatBerlinTime(xetraStartAt)}`
        : xetra.latest_cycle_at
          ? "Geschlossen"
          : "Nicht aktiv";

  const xetraCycleFooter =
    xetraRunning
      ? formatCountdown(xetra.next_cycle_at)
      : xetraPreOpen
        ? `Start ${formatBerlinTime(xetraStartAt)}`
      : xetra.latest_cycle_at
        ? `Letz ${formatBerlinTime(xetra.latest_cycle_at)}`
        : xetra.session_window || "Nicht aktiv";

  const usStatusFooter = usTradingActive ? formatUsSessionLabel(us.session_state, Boolean(us.market_open)) : `Start ${formatBerlinTime(usStartAt)}`;
  const usCycleFooter = usTradingActive ? formatCountdown(us.next_cycle_at) : `Start ${formatBerlinTime(usStartAt)}`;

  const tiles = {
    xetra_status: {
      key: "xetra_status",
      label: "Xetra",
      status: tileStatus(xetraStatus),
      line1: xetraPreOpen ? `Start ${formatBerlinTime(xetraStartAt)}` : formatTradeCountLine("Open", xetraOpenPositions),
      line2: xetraPreOpen ? formatCountdown(xetraStartAt) : formatTradeCountLine("Closed", xetraClosedPositions),
      footer: xetraStatusFooter,
      updatedAt
    },
    xetra_cycle: {
      key: "xetra_cycle",
      label: "Xetra Zyklus",
      status: tileStatus(xetraStatus),
      line1: xetraPreOpen ? `Start ${formatBerlinTime(xetraStartAt)}` : xetra.latest_cycle_at ? `Letz ${formatBerlinTime(xetra.latest_cycle_at)}` : "Kein Zyklus",
      line2:
        xetraRunning
          ? formatCountdown(xetra.next_cycle_at)
          : xetraPreOpen
            ? formatCountdown(xetraStartAt)
          : ["planned", "starting", "stopping"].includes(xetraState)
            ? formatCountdown(xetraStartAt)
            : "Kein Timer",
      footer: xetraRunning ? "Naechster" : xetraCycleFooter,
      updatedAt
    },
    us_status: {
      key: "us_status",
      label: "US Handel",
      status: tileStatus(usStatus),
      line1: usPreOpen ? `Start ${formatBerlinTime(usStartAt)}` : formatTradeCountLine("Open", usOpenPositions),
      line2: usPreOpen ? formatCountdown(usStartAt) : formatTradeCountLine("Closed", usClosedPositions),
      footer: usStatusFooter,
      updatedAt
    },
    us_cycle: {
      key: "us_cycle",
      label: "US Zyklus",
      status: tileStatus(usTradingActive ? usStatus : "idle"),
      line1: usPreOpen ? `Start ${formatBerlinTime(usStartAt)}` : us.last_cycle_at ? `Letz ${formatBerlinTime(us.last_cycle_at)}` : "Kein Zyklus",
      line2: usTradingActive ? formatCountdown(us.next_cycle_at) : formatCountdown(usStartAt),
      footer: usTradingActive ? "Naechster" : "Start",
      updatedAt
    }
  };

  return NOAH_TILE_ORDER.map(key => ({
    ...createDefaultNoahTile(key),
    ...(tiles[key] || {})
  }));
}

async function updateSlot(slotNumber, patch) {
  const slots = await readSlots();
  const slotIndex = normalizeSlot(slotNumber) - 1;
  slots[slotIndex] = applyPatch(slots[slotIndex], patch);
  await writeSlots(slots);
  void broadcastStateStream().catch(() => {});
  return slots[slotIndex];
}

async function updateAgent(agentName, patch) {
  const name = normalizeAgentName(agentName);
  const agents = await readAgents();
  const index = AGENT_ORDER.indexOf(name);
  agents[index] = applyAgentPatch(agents[index], patch);
  await writeAgents(agents);
  void broadcastStateStream().catch(() => {});
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
  void broadcastStateStream().catch(() => {});
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
  void broadcastStateStream().catch(() => {});
  return normalizedThreads.find(thread => thread.threadId === normalizedThreadId) || next;
}

async function setThreadName(threadId, label) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    throw new Error("thread id is required");
  }
  const normalizedLabel = await rememberThreadLabel(normalizedThreadId, label);
  void broadcastStateStream().catch(() => {});
  return {
    threadOrTaskId: normalizedThreadId,
    label: normalizedLabel
  };
}

async function buildMonitorState(options = {}) {
  const noahSummary = options.awaitNoahMonitor ? await getCachedNoahMonitor() : getImmediateNoahMonitor();
  return {
    slots: await loadEffectiveSlots(),
    agents: await loadEffectiveAgents(),
    threads: await loadExplicitThreads(),
    noahTiles: buildNoahTiles(noahSummary)
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  const body = JSON.stringify(payload);
  for (const line of body.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

function removeStateStreamClient(client) {
  clearInterval(client.heartbeat);
  stateStreamClients.delete(client);
}

function attachStateStreamClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  res.write(": connected\n\n");
  const client = {
    res,
    heartbeat: setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        removeStateStreamClient(client);
      }
    }, STATE_STREAM_HEARTBEAT_MS)
  };
  stateStreamClients.add(client);
  const cleanup = () => removeStateStreamClient(client);
  req.on("close", cleanup);
  res.on("close", cleanup);
  return client;
}

async function broadcastStateStream() {
  if (!stateStreamClients.size) {
    return;
  }
  const state = await buildMonitorState();
  for (const client of Array.from(stateStreamClients)) {
    try {
      sendSseEvent(client.res, "state", state);
    } catch {
      removeStateStreamClient(client);
    }
  }
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

function isAuthorizedAgentPush(req) {
  if (!AGENT_PUSH_TOKEN) {
    return true;
  }
  return readBearerToken(req) === AGENT_PUSH_TOKEN;
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

      if (req.method === "GET" && url.pathname === "/events") {
        const client = attachStateStreamClient(req, res);
        sendSseEvent(client.res, "state", await buildMonitorState());
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        sendJson(res, 200, await buildMonitorState({ awaitNoahMonitor: true }));
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
        if (!isAuthorizedAgentPush(req)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
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
      console.log(
        JSON.stringify(
          await buildMonitorState({ awaitNoahMonitor: true }),
          null,
          2
        )
      );
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
