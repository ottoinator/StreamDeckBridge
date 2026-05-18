import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.CODEX_MONITOR_PORT || 4567);
const HOST = process.env.CODEX_MONITOR_HOST || "127.0.0.1";

function getDefaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodexStreamDeckMonitor");
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodexStreamDeckMonitor");
}

const DATA_DIR = process.env.CODEX_MONITOR_DATA_DIR || getDefaultDataDir();
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
const NOAH_TILE_ORDER = ["cycle", "weekly_pnl", "daily_pnl", "trades_today", "live_markets"];
const STATE_STREAM_HEARTBEAT_MS = 15_000;
const DEFAULT_NOAH_MONITOR_BASE_URL = "http://100.98.171.9:8765";
const CODEX_SESSION_AUTODETECT_WINDOW_MS = Number(process.env.CODEX_MONITOR_CODEX_SESSION_WINDOW_MS || 6 * 60 * 60 * 1000);
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

const LEGACY_NOAH_VPS_STATUS_COMMAND = (
  "python3 - <<'PY'\nfrom pathlib import Path\nimport json\nbase=Path('/root/.openclaw/workspace/.pi')\nfiles={\n  'paper_cycle': base/'paper_cycle.log.jsonl',\n  'main_bundle': base/'artifacts'/'noah3'/'main_decision_bundle.json',\n  'companion_log': base/'companion_api.log',\n  'companion_access_log': base/'companion_api_access.log.jsonl',\n  'owner_health_alert_state': base/'owner_health_alert_state.json',\n  'main_sessions': Path('/root/.openclaw/agents/main/sessions')/'sessions.json',\n}\nout={}\nfor key, path in files.items():\n    out[key]={'exists': path.exists(), 'mtime': path.stat().st_mtime if path.exists() else None}\nlatest_session=None\nsessions_dir=Path('/root/.openclaw/agents/main/sessions')\nif sessions_dir.exists():\n    files=sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session={'exists': True, 'mtime': files[0].stat().st_mtime, 'name': files[0].name}\nout['latest_session']=latest_session\nprint(json.dumps(out))\nPY"
);

const LEGACY_CARMEN_VPS_STATUS_COMMAND = (
  "python3 - <<'PY'\nfrom pathlib import Path\nimport json, subprocess\nstatus = json.loads(subprocess.check_output(['python3','/root/.openclaw/workspace/integrations/whatsapp/vnext_status.py'], text=True))\nsessions_dir = Path('/root/.openclaw/agents/main/sessions')\nlatest_session_mtime = None\nlatest_session_file = None\nif sessions_dir.exists():\n    files = sorted([p for p in sessions_dir.glob('*.jsonl')], key=lambda p: p.stat().st_mtime, reverse=True)\n    if files:\n        latest_session_file = files[0].name\n        latest_session_mtime = files[0].stat().st_mtime\nroots = [\n    Path('/root/.openclaw/workspace/integrations/whatsapp/logs'),\n    Path('/root/.openclaw/workspace/integrations/whatsapp/state'),\n    Path('/root/.openclaw/agents/main/sessions'),\n]\nrecent_mtime = None\nrecent_file = None\nfor root in roots:\n    if not root.exists():\n        continue\n    for candidate in root.rglob('*'):\n        try:\n            if not candidate.is_file():\n                continue\n            mtime = candidate.stat().st_mtime\n        except Exception:\n            continue\n        if recent_mtime is None or mtime > recent_mtime:\n            recent_mtime = mtime\n            recent_file = str(candidate)\nstatus['mainSessions'] = {'latestFile': latest_session_file, 'latestMtime': latest_session_mtime}\nstatus['activityFiles'] = {'latestFile': recent_file, 'latestMtime': recent_mtime}\nprint(json.dumps(status))\nPY"
);

const DEFAULT_CARMEN_LOCAL_STATUS_COMMAND =
  "docker exec carmen-runtime sh -lc 'cd /root/.openclaw/workspace && python3 integrations/whatsapp/openai_activity.py'";

function buildUrl(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createNoahRemoteConfig() {
  const statusUrl = process.env.CODEX_MONITOR_NOAH_STATUS_URL;
  if (statusUrl) {
    return {
      kind: "http-json",
      url: statusUrl,
      headers: buildAgentRemoteHeaders("CODEX_MONITOR_NOAH"),
      timeoutMs: parseOptionalNumber(process.env.CODEX_MONITOR_NOAH_STATUS_TIMEOUT_MS, 4_000)
    };
  }

  const timeoutMs = parseOptionalNumber(process.env.CODEX_MONITOR_NOAH_STATUS_TIMEOUT_MS, 8_000);
  const sshHost = process.env.CODEX_MONITOR_NOAH_SSH_HOST;
  if (sshHost || process.env.CODEX_MONITOR_NOAH_STATUS_COMMAND) {
    return {
      kind: "ssh-json",
      host: sshHost || "ocvps",
      command: process.env.CODEX_MONITOR_NOAH_STATUS_COMMAND || LEGACY_NOAH_VPS_STATUS_COMMAND,
      timeoutMs
    };
  }

  return {
    kind: "http-json",
    url: buildUrl(process.env.CODEX_MONITOR_NOAH_MONITOR_BASE_URL || DEFAULT_NOAH_MONITOR_BASE_URL, "/api/v1/status/openai-activity"),
    headers: buildAgentRemoteHeaders("CODEX_MONITOR_NOAH"),
    timeoutMs: parseOptionalNumber(process.env.CODEX_MONITOR_NOAH_STATUS_TIMEOUT_MS, 4_000)
  };
}

function formatRuntimeAge(value) {
  const timestamp = Date.parse(String(value || ""));
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return formatAgeCompact(Date.now() - timestamp);
}

function makeNoahRuntimeProbe(summary) {
  if (!summary || summary.error) {
    return makeProbeResult("offline", `Noah offline: ${summary?.error || "Keine Monitor-Daten"}`);
  }
  const cycle = summary.cycle || {};
  const pnl = summary.pnl || {};
  const trades = summary.trades_today || {};
  const live = summary.live || {};
  const tradingMarkets = Array.isArray(live.trading_markets) ? live.trading_markets : [];
  const configuredMarkets = Array.isArray(live.configured_markets) ? live.configured_markets : [];
  const marketLabel = cycle.market_label || tradingMarkets[0] || configuredMarkets[0] || "Noah";
  const modeLabel = cycle.mode_label || (cycle.trading ? "Live" : "Idle");
  const status = summary.stale_reason ? "attention" : "online";
  const checkedAge = formatRuntimeAge(summary.checked_at);
  const detail = cycle.trading
    ? `Runtime ${marketLabel} ${modeLabel}`.trim()
    : `Runtime ${marketLabel} idle`.trim();
  const activityMetric = [
    cycle.next_cycle_at || "",
    cycle.trading ? "open" : "closed",
    Math.round(Number(pnl.daily_eur || 0) * 100),
    Math.round(Number(pnl.weekly_eur || 0) * 100),
    Number(trades.open || 0),
    Number(trades.closed || 0)
  ].join(":");
  return makeProbeResult(status, checkedAge ? `${detail} (${checkedAge})` : detail, {
    activityMetric,
    allowRemoteActivity: true
  });
}

function createCarmenRemoteConfig() {
  const statusUrl = process.env.CODEX_MONITOR_CARMEN_STATUS_URL;
  if (statusUrl) {
    return {
      kind: "http-json",
      url: statusUrl,
      headers: buildAgentRemoteHeaders("CODEX_MONITOR_CARMEN"),
      timeoutMs: parseOptionalNumber(process.env.CODEX_MONITOR_CARMEN_STATUS_TIMEOUT_MS, 4_000)
    };
  }

  const timeoutMs = parseOptionalNumber(process.env.CODEX_MONITOR_CARMEN_STATUS_TIMEOUT_MS, 8_000);
  const sshHost = process.env.CODEX_MONITOR_CARMEN_SSH_HOST;
  if (sshHost) {
    return {
      kind: "ssh-json",
      host: sshHost,
      command: process.env.CODEX_MONITOR_CARMEN_STATUS_COMMAND || LEGACY_CARMEN_VPS_STATUS_COMMAND,
      timeoutMs
    };
  }

  if (process.platform === "darwin" || process.env.CODEX_MONITOR_CARMEN_LOCAL_STATUS_COMMAND) {
    return {
      kind: "local-json",
      command:
        process.env.CODEX_MONITOR_CARMEN_LOCAL_STATUS_COMMAND ||
        process.env.CODEX_MONITOR_CARMEN_STATUS_COMMAND ||
        DEFAULT_CARMEN_LOCAL_STATUS_COMMAND,
      timeoutMs
    };
  }

  return {
    kind: "ssh-json",
    host: "carmen-vps",
    command: process.env.CODEX_MONITOR_CARMEN_STATUS_COMMAND || LEGACY_CARMEN_VPS_STATUS_COMMAND,
    timeoutMs
  };
}

const AGENT_REMOTE_DEFAULTS = {
  noah: createNoahRemoteConfig(),
  carmen: createCarmenRemoteConfig()
};
const agentProbeCache = new Map();
const agentProbeInflight = new Map();
const noahMonitorCache = {
  cachedAt: 0,
  result: null,
  lastGoodResult: null
};
const TRADE_COUNTER_CACHE_TTL_MS = 60_000;
const noahTradeCounterCache = {
  xetra: { value: null, cachedAt: 0 },
  us: { value: null, cachedAt: 0 }
};
let noahMonitorInflight = null;
const NOAH_MONITOR_DEFAULTS = {
  host: process.env.CODEX_MONITOR_NOAH_SSH_HOST || (AGENT_REMOTE_DEFAULTS.noah.kind === "ssh-json" ? AGENT_REMOTE_DEFAULTS.noah.host : "ocvps"),
  command:
    process.env.CODEX_MONITOR_NOAH_MONITOR_COMMAND ||
    String.raw`python3 - <<'PY'
import json,subprocess,urllib.request
def tok():
    try:s=subprocess.check_output(['systemctl','cat','noah_companion_api.service'],text=True,stderr=subprocess.DEVNULL)
    except Exception:return None
    for line in s.splitlines():
        if line.startswith('Environment=NOAH_COMPANION_API_TOKEN='): return line.split('=',2)[2].strip()
    return None
def get(path,t,timeout=20):
    h={'Accept':'application/json'}
    if t: h['Authorization']='Bearer '+t
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765'+path,headers=h),timeout=timeout) as y: return json.load(y)
def market_label(market):
    return {'us':'US','xetra':'EU','eu_multi':'EU','index_futures':'IF'}.get(str(market or '').strip().lower(), str(market or '').upper()[:2] or '??')
def product_label(market):
    return 'FUT' if str(market or '').strip().lower() == 'index_futures' else 'EQ'
def short_mode(value):
    raw=str(value or '').strip().lower()
    mapping={'morning_burst':'Burst','open_stabilization':'Stabi','early_attack':'Attack','regular_day':'RegDay','tradeable':'Trade','defensive':'Def','close_only':'Exit','idle':'Idle'}
    return mapping.get(raw, raw.replace('_',' ').title()[:8] if raw else 'Warte')
t=tok()
combined = get('/api/v1/status/current?market=combined', t, timeout=20)
intraday = get('/api/v1/intraday/today?market=combined', t, timeout=20)
markets = list(intraday.get('available_markets') or combined.get('available_markets') or [])
rows=[]
for market in markets:
    status = ((combined.get('markets') or {}).get(market) or {})
    intraday_row = ((intraday.get('markets') or {}).get(market) or {})
    observer = get(f'/api/v1/view/observer-card?market={market}', t, timeout=20)
    portfolio = (observer or {}).get('portfolio') or {}
    trade_activity = (observer or {}).get('trade_activity') or {}
    runtime_mode = (intraday_row.get('runtime_mode') or {})
    session_status = str(status.get('market_session_status') or '').strip().lower()
    rows.append({
        'market': market,
        'label': market_label(market),
        'product': product_label(market),
        'trading': session_status == 'open',
        'mode_label': short_mode(runtime_mode.get('execution_window_mode') or runtime_mode.get('runtime_mode') or session_status),
        'next_cycle_at': runtime_mode.get('next_regular_cycle_ts_et') or status.get('next_cycle_ts_et') or combined.get('next_cycle_ts_et'),
        'daily_pnl_eur': float(portfolio.get('daily_pnl_eur') or 0.0),
        'daily_pnl_pct': float(portfolio.get('daily_pnl_pct') or 0.0),
        'weekly_pnl_eur': float(portfolio.get('weekly_pnl_eur') or 0.0),
        'weekly_pnl_pct': float(portfolio.get('weekly_pnl_pct') or 0.0),
        'open_trades': int(trade_activity.get('open_positions') or 0),
        'closed_trades': int(trade_activity.get('closed_trades') or 0),
    })
active_market = combined.get('active_market')
cycle_row = next((row for row in rows if row['market'] == active_market and row.get('next_cycle_at')), None) or next((row for row in rows if row['trading'] and row.get('next_cycle_at')), None) or next((row for row in rows if row.get('next_cycle_at')), None) or next((row for row in rows if row['market'] == active_market), None) or next((row for row in rows if row['trading']), None) or (rows[0] if rows else None)
print(json.dumps({
    'checked_at': intraday.get('generated_at_utc') or combined.get('generated_at_utc'),
    'cycle': {
        'market_label': cycle_row.get('label') if cycle_row else None,
        'mode_label': cycle_row.get('mode_label') if cycle_row else None,
        'next_cycle_at': cycle_row.get('next_cycle_at') if cycle_row else None,
        'trading': bool(cycle_row and cycle_row.get('trading')),
    },
    'pnl': {
        'daily_eur': round(sum(row['daily_pnl_eur'] for row in rows), 2),
        'daily_pct': round(sum(row['daily_pnl_pct'] for row in rows), 2),
        'weekly_eur': round(sum(row['weekly_pnl_eur'] for row in rows), 2),
        'weekly_pct': round(sum(row['weekly_pnl_pct'] for row in rows), 2),
    },
    'trades_today': {
        'open': int(sum(row['open_trades'] for row in rows)),
        'closed': int(sum(row['closed_trades'] for row in rows)),
    },
    'live': {
        'configured_markets': sorted(set(row['label'] for row in rows)),
        'configured_products': sorted(set(row['product'] for row in rows)),
        'trading_markets': sorted(set(row['label'] for row in rows if row['trading'])),
        'trading_products': sorted(set(row['product'] for row in rows if row['trading'])),
    },
}))
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

function codexSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

async function listCodexSessionFiles(root = codexSessionsRoot()) {
  const files = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async entry => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = await stat(fullPath);
          files.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
        } catch {
        }
      }
    }));
  }
  await walk(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function threadIdFromSessionPath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : "";
}

function parseSessionWorkdir(entry) {
  if (entry?.type !== "response_item" || entry.payload?.type !== "function_call") {
    return "";
  }
  const raw = String(entry.payload.arguments || "");
  if (!raw) {
    return "";
  }
  try {
    const args = JSON.parse(raw);
    return String(args.workdir || "").trim();
  } catch {
    return "";
  }
}

function parseCodexSessionState(raw, filePath, mtimeMs) {
  const threadId = threadIdFromSessionPath(filePath);
  if (!threadId) {
    return null;
  }

  const lines = raw.trimEnd().split(/\r?\n/).slice(-400);
  let lastUserMessageAt = null;
  let lastFinalAnswerAt = null;
  let lastTaskCompleteAt = null;
  let lastActivityAt = mtimeMs;
  let latestWorkdir = "";
  let latestCommentary = "";

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = Date.parse(String(entry.timestamp || ""));
    if (!Number.isNaN(timestamp)) {
      lastActivityAt = Math.max(lastActivityAt, timestamp);
    }
    const workdir = parseSessionWorkdir(entry);
    if (workdir) {
      latestWorkdir = workdir;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
      lastUserMessageAt = Math.max(lastUserMessageAt || 0, timestamp || 0);
      continue;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "task_complete") {
      lastTaskCompleteAt = Math.max(lastTaskCompleteAt || 0, timestamp || 0);
      continue;
    }
    if (
      entry.type === "response_item" &&
      entry.payload?.type === "message" &&
      entry.payload?.role === "assistant" &&
      entry.payload?.phase === "final_answer"
    ) {
      lastFinalAnswerAt = Math.max(lastFinalAnswerAt || 0, timestamp || 0);
      continue;
    }
    if (
      entry.type === "response_item" &&
      entry.payload?.type === "message" &&
      entry.payload?.phase === "commentary" &&
      Array.isArray(entry.payload.content)
    ) {
      const text = entry.payload.content
        .map(item => item?.text || "")
        .join(" ")
        .trim();
      if (text) {
        latestCommentary = text;
      }
    }
  }

  const lastDoneAt = Math.max(lastFinalAnswerAt || 0, lastTaskCompleteAt || 0);
  if (!lastUserMessageAt || lastDoneAt > lastUserMessageAt) {
    return null;
  }
  if (Date.now() - lastActivityAt > CODEX_SESSION_AUTODETECT_WINDOW_MS) {
    return null;
  }

  return {
    threadId,
    label: latestWorkdir ? path.basename(latestWorkdir) : `Chat ${getShortThreadToken(threadId)}`,
    status: "running",
    detail: latestCommentary ? latestCommentary.slice(0, 80) : "Codex arbeitet",
    updatedAt: new Date(lastActivityAt).toISOString(),
    startedAt: lastUserMessageAt ? new Date(lastUserMessageAt).toISOString() : new Date(lastActivityAt).toISOString(),
    heartbeatAt: new Date(lastActivityAt).toISOString(),
    finishedAt: null,
    exitCode: null,
    source: "codex-session"
  };
}

async function discoverActiveCodexSessions() {
  const files = (await listCodexSessionFiles()).slice(0, 30);
  const sessions = [];
  for (const file of files) {
    try {
      const raw = await readFile(file.path, "utf8");
      const state = parseCodexSessionState(raw, file.path, file.mtimeMs);
      if (state) {
        sessions.push(state);
      }
    } catch {
    }
  }
  return sessions.sort((left, right) => {
    const leftStarted = Date.parse(left.startedAt || left.updatedAt || nowIso());
    const rightStarted = Date.parse(right.startedAt || right.updatedAt || nowIso());
    if (leftStarted !== rightStarted) {
      return leftStarted - rightStarted;
    }
    return left.threadId.localeCompare(right.threadId);
  });
}

function overlayAutodetectedSessions(slots, explicitThreads, discoveredSessions) {
  const explicitThreadIds = new Set(explicitThreads.map(thread => thread.threadId));
  const usedSlots = new Set(
    slots
      .filter(slot => slot.status !== "idle" || slot.source === "codex-app")
      .map(slot => slot.slot)
  );
  const freeSlots = [1, 2, 3, 4].filter(slot => !usedSlots.has(slot));
  const candidates = discoveredSessions.filter(candidate => !explicitThreadIds.has(candidate.threadId));
  let candidateIndex = 0;

  return slots.map(slot => {
    if (usedSlots.has(slot.slot)) {
      return slot;
    }
    if (!freeSlots.includes(slot.slot)) {
      return slot;
    }
    const session = candidates[candidateIndex];
    if (!session) {
      return slot;
    }
    candidateIndex += 1;
    return {
      ...slot,
      ...threadToSlotState({ ...session, slot: slot.slot }, {}, session.label),
      autodetected: true
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
  const withAutodetectedSessions = overlayAutodetectedSessions(
    withExplicitThreads,
    explicitThreads,
    await discoverActiveCodexSessions()
  );
  if (!ENABLE_PROCESS_AUTODETECT) {
    return withAutodetectedSessions;
  }
  const discoveredProcesses = await discoverCodexProcesses();
  return overlayDiscoveredProcesses(withAutodetectedSessions, discoveredProcesses);
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

async function runLocalJson(command, timeout = 8_000) {
  const { stdout } = await execFileAsync(
    "sh",
    ["-lc", command],
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
  if (config?.kind === "local-json") {
    return runLocalJson(config.command, config.timeoutMs);
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
  const hasWindowTokens = Number.isFinite(windowTokens);
  const hasOpenAiPayload = Boolean(payload.openai || payload.activity || payload.usage || payload.tokens || hasWindowTokens || Number.isFinite(totalTokens));
  const activityMetric =
    (hasWindowTokens
        ? `window:${Math.trunc(windowTokens)}:${lastActivityAt || ""}`
        : firstStringValue(payload, ["activityMetric", "activity.metric", "openai.activityMetric"]) ||
          (Number.isFinite(totalTokens)
            ? `tokens:${Math.trunc(totalTokens)}`
            : lastActivityAt
              ? `activity:${lastActivityAt}`
              : undefined));
  const detail =
    (hasWindowTokens
      ? `OpenAI ${formatTokenCount(windowTokens)} Tok/${windowMinutes}m`
      : hasOpenAiPayload
        ? `OpenAI 0 Tok/${windowMinutes}m`
        : firstStringValue(payload, ["detail", "activity.detail", "openai.detail"]) ||
          (Number.isFinite(totalTokens)
            ? `OpenAI ${formatTokenCount(totalTokens)} Tok ges.`
            : undefined));

  if (!detail && recentActivity === undefined && activityMetric === undefined) {
    return null;
  }

  return {
    detail,
    recentActivity:
      recentActivity !== undefined
        ? recentActivity
        : hasWindowTokens
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

  return makeProbeResult(explicitStatus, openAiActivity?.detail || explicitDetail || fallbackDetail, {
    recentActivity: explicitRecentActivity ?? openAiActivity?.recentActivity,
    activityMetric: openAiActivity?.activityMetric || explicitActivityMetric,
    allowRemoteActivity: openAiActivity?.allowRemoteActivity || explicitRecentActivity !== undefined || explicitActivityMetric !== undefined
  });
}

async function probeNoahRemote() {
  try {
    const monitorSummary = await getCachedNoahMonitor();
    if (hasUsableNoahSummary(monitorSummary)) {
      return makeNoahRuntimeProbe(monitorSummary);
    }
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
    const explicit = makeExplicitProbeResult(payload, "online", "Carmen erreichbar");
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
      return makeProbeResult("online", `Carmen online (${mode})`, {
        activityMetric: `${lastAcceptedSeq}:${lastProcessedSeq}:${latestSeq}:${latestSessionMtime}:${latestActivityFileMtime}`,
        recentActivity: hasRecentActivity
      });
    }

    if (payload?.ok) {
      return makeProbeResult("attention", "Carmen laeuft, aber Transport ist nicht voll bereit");
    }

    return makeProbeResult("attention", "Carmen meldet Problem");
  } catch (error) {
    return makeProbeResult("offline", `Carmen offline: ${error instanceof Error ? error.message : String(error)}`);
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
    const hasRecentExplicitSignal = Number.isFinite(heartbeatAge) && heartbeatAge <= AGENT_HEARTBEAT_TIMEOUT_MS;
    const previous = agentProbeCache.get(agent.name)?.previousResult;
    const remoteActivityEnabled = probe.allowRemoteActivity || ENABLE_REMOTE_AGENT_ACTIVITY;
    const changedActivityMetric =
      remoteActivityEnabled &&
      probe.recentActivity !== false &&
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

function formatSignedEuro(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "EUR --";
  }
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  const formatted = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: Math.abs(amount) < 100 ? 2 : 0,
    maximumFractionDigits: 2
  }).format(Math.abs(amount));
  return `${sign}${formatted} EUR`;
}

function formatSignedPercent(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "--%";
  }
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${Math.abs(amount).toFixed(2)}%`;
}

function isFutureTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return !Number.isNaN(parsed) && parsed > Date.now();
}

function normalizeFutureCycleTimestamp(value, intervalMinutes) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isNaN(parsed)) {
    return null;
  }
  const now = Date.now();
  if (parsed > now) {
    return new Date(parsed).toISOString();
  }
  const interval = Number(intervalMinutes);
  if (!Number.isFinite(interval) || interval <= 0) {
    return null;
  }
  const intervalMs = Math.round(interval * 60_000);
  const steps = Math.floor((now - parsed) / intervalMs) + 1;
  return new Date(parsed + steps * intervalMs).toISOString();
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nonZeroNumber(value, epsilon = 0.005) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.abs(numeric) > epsilon ? numeric : null;
}

function portfolioWeekPnlEur(portfolio) {
  const explicit = nonZeroNumber(portfolio?.weekly_pnl_eur);
  if (explicit !== null) {
    return explicit;
  }
  const current = finiteNumber(portfolio?.current_portfolio_value_eur, NaN);
  const weekStart = finiteNumber(portfolio?.week_start_value_eur, NaN);
  if (Number.isFinite(current) && Number.isFinite(weekStart)) {
    const delta = nonZeroNumber(current - weekStart);
    if (delta !== null) {
      return delta;
    }
  }
  const realized = finiteNumber(portfolio?.realized_pnl_eur_total, NaN);
  const unrealized = finiteNumber(portfolio?.unrealized_pnl_eur_total, 0);
  if (Number.isFinite(realized)) {
    const total = nonZeroNumber(realized + unrealized);
    if (total !== null) {
      return total;
    }
  }
  return finiteNumber(portfolio?.weekly_pnl_eur, 0);
}

function portfolioWeekPnlPct(portfolio, pnlEur) {
  const explicit = nonZeroNumber(portfolio?.weekly_pnl_pct, 0.0005);
  if (explicit !== null) {
    return explicit;
  }
  const weekStart = finiteNumber(portfolio?.week_start_value_eur, NaN);
  if (Number.isFinite(weekStart) && Math.abs(weekStart) > 0.005) {
    return (finiteNumber(pnlEur, 0) / weekStart) * 100;
  }
  return finiteNumber(portfolio?.weekly_pnl_pct, 0);
}

function chooseNoahCycleTimestamp(status, runtimeMode, topStatus = {}, isActiveMarket = false) {
  const intervalMinutes =
    finiteNumber(status?.cycle_interval_minutes, 0) ||
    finiteNumber(topStatus?.cycle_interval_minutes, 0) ||
    finiteNumber(runtimeMode?.cycle_interval_minutes, 0) ||
    finiteNumber(runtimeMode?.morning_burst_plan?.guards?.regular_cycle_minutes, 0);
  const candidates = [
    status?.next_cycle_ts_et,
    isActiveMarket ? topStatus?.next_cycle_ts_et : null,
    runtimeMode?.next_cycle_ts_et,
    status?.next_regular_cycle_ts_et,
    runtimeMode?.next_regular_cycle_ts_et
  ];
  for (const candidate of candidates) {
    const normalized = normalizeFutureCycleTimestamp(candidate, intervalMinutes);
    if (normalized && isFutureTimestamp(normalized)) {
      return normalized;
    }
  }
  return candidates.find(Boolean) || null;
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

function isWeekendInZone(value, timeZone) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short"
  }).format(value);
  return weekday === "Sat" || weekday === "Sun";
}

function isNoahNonTradingDay(summary, now = new Date()) {
  if (summary?.error) {
    return false;
  }
  const live = summary?.live || {};
  const tradingMarkets = Array.isArray(live.trading_markets) ? live.trading_markets : [];
  if (tradingMarkets.length > 0 || summary?.cycle?.trading) {
    return false;
  }
  return Boolean(summary?.market_closed) || (isWeekendInZone(now, "Europe/Berlin") && isWeekendInZone(now, "America/New_York"));
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

function isXetraSessionDayActive(sessionWindow) {
  const normalized = String(sessionWindow || "").trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("CLOSED") || normalized.includes("CLOSE")) {
    return false;
  }
  return ["OPEN", "TRADE", "ACTIVE", "CONTINUOUS", "AUCTION", "HALT", "PAUSE", "INTERRUPT"].some(token =>
    normalized.includes(token)
  );
}

function isBerlinXetraTradingWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const weekday = parts.find(part => part.type === "weekday")?.value || "";
  const hour = Number(parts.find(part => part.type === "hour")?.value || "0");
  const minute = Number(parts.find(part => part.type === "minute")?.value || "0");
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const minutes = hour * 60 + minute;
  return isWeekday && minutes >= 9 * 60 && minutes <= 17 * 60 + 30;
}

function createDefaultNoahTile(key) {
  const labels = {
    cycle: "Noah Zyklus",
    weekly_pnl: "Wochen PnL",
    daily_pnl: "Tages PnL",
    trades_today: "Trades Heute",
    live_markets: "Live Markt"
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

function compactCodes(values, fallback = "-") {
  const items = Array.isArray(values)
    ? values.map(value => String(value || "").trim()).filter(Boolean)
    : [];
  return items.length ? items.join(" ") : fallback;
}

function blankTileLine() {
  return " ";
}

function pnlStatus(value, degraded) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "idle";
  }
  if (degraded) {
    return "warn";
  }
  if (amount > 0) {
    return "ok";
  }
  if (amount < 0) {
    return "error";
  }
  return "idle";
}

function makeNoahProbeFallback(message) {
  return {
    checked_at: nowIso(),
    error: String(message || "Noah Monitor nicht verfuegbar"),
    cycle: null,
    pnl: null,
    trades_today: null,
    live: null,
    markets: []
  };
}

function hasUsableNoahSummary(summary) {
  if (!summary || summary.error) {
    return false;
  }
  return Boolean(summary.cycle || summary.pnl || summary.trades_today || summary.live);
}

function buildStaleNoahSummary(previous, message) {
  return {
    ...previous,
    checked_at: nowIso(),
    stale_reason: String(message || "Noah Monitor nicht verfuegbar")
  };
}

function getNoahMonitorBaseUrl() {
  for (const candidate of [
    process.env.CODEX_MONITOR_NOAH_API_BASE_URL,
    process.env.CODEX_MONITOR_NOAH_MONITOR_BASE_URL,
    process.env.CODEX_MONITOR_NOAH_STATUS_URL,
    DEFAULT_NOAH_MONITOR_BASE_URL
  ]) {
    const raw = String(candidate || "").trim();
    if (!raw) {
      continue;
    }
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}`;
    } catch {
      continue;
    }
  }
  return null;
}

function createNoahMonitorUrl(baseUrl, pathName, market = "combined") {
  const url = new URL(pathName, baseUrl);
  url.searchParams.set("market", market);
  return url.toString();
}

function normalizeNoahMarketKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "xetra" || raw === "eu_multi" || raw === "eu") {
    return "xetra";
  }
  if (raw === "japan_equities" || raw === "japan" || raw === "tse") {
    return "japan_equities";
  }
  if (raw === "index_futures" || raw === "futures" || raw === "global_futures") {
    return "index_futures";
  }
  return raw || "us";
}

function noahMarketLabel(value) {
  const market = normalizeNoahMarketKey(value);
  if (market === "xetra") {
    return "EU";
  }
  if (market === "japan_equities") {
    return "JP";
  }
  if (market === "index_futures") {
    return "IF";
  }
  return "US";
}

function noahProductLabel(value) {
  const market = normalizeNoahMarketKey(value);
  return market === "index_futures" ? "FUT" : "EQ";
}

function shortCycleMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  const mapping = {
    morning_burst: "Burst",
    open_stabilization: "Stabi",
    early_attack: "Attack",
    regular_day: "RegDay",
    tradeable: "Trade",
    defensive: "Def",
    close_only: "Exit",
    open: "Open",
    closed: "Close"
  };
  return mapping[raw] || titleCaseValue(raw || "warte").slice(0, 8);
}

function buildNoahSummary(statusCard, observerCard) {
  const statusMarkets = statusCard?.markets && typeof statusCard.markets === "object" ? statusCard.markets : {};
  const observerMarkets = observerCard?.markets && typeof observerCard.markets === "object" ? observerCard.markets : {};
  const marketKeys = Array.from(new Set([...Object.keys(statusMarkets), ...Object.keys(observerMarkets)]));
  const activeMarketKey = normalizeNoahMarketKey(statusCard?.active_market || observerCard?.active_market);
  const marketRows = marketKeys.map(key => {
    const normalizedKey = normalizeNoahMarketKey(key);
    const status = statusMarkets[key] || {};
    const observer = observerMarkets[key] || {};
    const tradeActivity = observer.trade_activity || {};
    const portfolio = observer.portfolio || {};
    const runtimeMode = status.runtime_mode || {};
    const sessionStatus = String(status.market_session_status || status.active_market_status || "").trim().toLowerCase();
    const statusTradeDay = String(status.trade_day || status.market_session?.trade_day || "").trim();
    const observerTradeDay = String(observer.trade_day || tradeActivity.trade_day || "").trim();
    const portfolioTradeDay = String(portfolio.trade_day || "").trim();
    const staleForStatusDay = Boolean(
      statusTradeDay &&
      ((observerTradeDay && observerTradeDay !== statusTradeDay) || (portfolioTradeDay && portfolioTradeDay !== statusTradeDay))
    );
    const weeklyPnlEur = portfolioWeekPnlEur(portfolio);
    return {
      key: normalizedKey,
      label: noahMarketLabel(normalizedKey),
      product: noahProductLabel(normalizedKey),
      trading: sessionStatus === "open" && !staleForStatusDay,
      nextCycleAt: staleForStatusDay ? null : chooseNoahCycleTimestamp(status, runtimeMode, statusCard, normalizedKey === activeMarketKey),
      modeLabel: shortCycleMode(runtimeMode.execution_window_mode || runtimeMode.runtime_mode || status.posture?.session_state || sessionStatus),
      openTrades: staleForStatusDay ? 0 : Number(tradeActivity.open_positions || 0),
      closedTrades: staleForStatusDay ? 0 : Number(tradeActivity.closed_trades || 0),
      dailyPnlEur: staleForStatusDay ? 0 : Number(portfolio.daily_pnl_eur || 0),
      dailyPnlPct: staleForStatusDay ? 0 : Number(portfolio.daily_pnl_pct || 0),
      weeklyPnlEur: staleForStatusDay ? 0 : weeklyPnlEur,
      weeklyPnlPct: staleForStatusDay ? 0 : portfolioWeekPnlPct(portfolio, weeklyPnlEur),
      staleForStatusDay
    };
  });

  const activeCycleRow =
    marketRows.find(row => row.key === activeMarketKey && row.nextCycleAt) ||
    marketRows.find(row => row.trading && row.nextCycleAt) ||
    marketRows.find(row => row.trading) ||
    marketRows
      .filter(row => row.nextCycleAt)
      .sort((left, right) => Date.parse(String(left.nextCycleAt)) - Date.parse(String(right.nextCycleAt)))[0] ||
    marketRows[0] ||
    null;

  const combinedPortfolio = observerCard?.portfolio || {};
  let weeklyEur = portfolioWeekPnlEur(combinedPortfolio);
  if (!nonZeroNumber(weeklyEur)) {
    const activeWeekly = marketRows.find(row => row.key === activeMarketKey && nonZeroNumber(row.weeklyPnlEur));
    const tradingWeekly = marketRows.find(row => row.trading && nonZeroNumber(row.weeklyPnlEur));
    weeklyEur = activeWeekly?.weeklyPnlEur ?? tradingWeekly?.weeklyPnlEur ?? marketRows.reduce((sum, row) => sum + row.weeklyPnlEur, 0);
  }
  let weeklyPct = portfolioWeekPnlPct(combinedPortfolio, weeklyEur);
  if (!nonZeroNumber(weeklyPct, 0.0005)) {
    const activeWeekly = marketRows.find(row => row.key === activeMarketKey && nonZeroNumber(row.weeklyPnlPct, 0.0005));
    const tradingWeekly = marketRows.find(row => row.trading && nonZeroNumber(row.weeklyPnlPct, 0.0005));
    weeklyPct = activeWeekly?.weeklyPnlPct ?? tradingWeekly?.weeklyPnlPct ?? marketRows.reduce((sum, row) => sum + row.weeklyPnlPct, 0);
  }
  const configuredMarkets = marketRows.map(row => row.label);
  const configuredProducts = Array.from(new Set(marketRows.map(row => row.product)));
  const tradingMarkets = marketRows.filter(row => row.trading).map(row => row.label);
  const tradingProducts = Array.from(new Set(marketRows.filter(row => row.trading).map(row => row.product)));
  const marketClosed = tradingMarkets.length === 0;

  return {
    checked_at: nowIso(),
    market_closed: marketClosed,
    cycle: activeCycleRow && !marketClosed
      ? {
          market_label: activeCycleRow.label,
          mode_label: activeCycleRow.modeLabel,
          next_cycle_at: activeCycleRow.nextCycleAt,
          trading: activeCycleRow.trading
        }
      : null,
    pnl: {
      daily_eur: marketClosed ? 0 : Number(combinedPortfolio.daily_pnl_eur || 0),
      daily_pct: marketClosed ? 0 : Number(combinedPortfolio.daily_pnl_pct || 0),
      weekly_eur: marketClosed ? 0 : weeklyEur,
      weekly_pct: marketClosed ? 0 : weeklyPct
    },
    trades_today: {
      open: marketClosed ? 0 : marketRows.reduce((sum, row) => sum + Math.max(0, row.openTrades || 0), 0),
      closed: marketClosed ? 0 : marketRows.reduce((sum, row) => sum + Math.max(0, row.closedTrades || 0), 0)
    },
    live: {
      configured_markets: configuredMarkets,
      configured_products: configuredProducts,
      trading_markets: tradingMarkets,
      trading_products: tradingProducts
    }
  };
}

function buildNoahSummaryFromObserverLive(payload, statusByMarket = {}) {
  const markets = payload?.markets && typeof payload.markets === "object" ? payload.markets : {};
  const sessions = payload?.sessions && typeof payload.sessions === "object" ? payload.sessions : {};
  const fallbackNextCycle = marketKey => {
    const normalized = normalizeNoahMarketKey(marketKey);
    if (normalized === "xetra") {
      return nextBerlinWeekdayTime(9, 0);
    }
    if (normalized === "us") {
      return nextBerlinWeekdayTime(15, 30);
    }
    return null;
  };
  const rows = Object.keys(markets).map(key => {
    const market = markets[key] || {};
    const session = sessions[key] || {};
    const status = statusByMarket[key] || {};
    const runtimeMode = market.runtime_mode || {};
    const tradeActivity = market.trade_activity || {};
    const portfolio = market.portfolio || {};
    const marketKey = market.market_registry?.market_key || key;
    const sessionOpen =
      String(status.market_session_status || session.market_session_status || "").trim().toLowerCase() === "open" ||
      Boolean(status.market_open ?? market.market_open);
    const rawNextCycleAt =
      status.next_regular_cycle_ts_et ||
      status.next_cycle_ts_et ||
      runtimeMode.next_regular_cycle_ts_et ||
      session.next_cycle_ts_et ||
      payload?.next_cycle_ts_et;
    const cycleIntervalMinutes =
      Number(
        status.cycle_interval_minutes ||
        runtimeMode.cycle_interval_minutes ||
        runtimeMode?.morning_burst_plan?.guards?.regular_cycle_minutes ||
        0
      ) || 0;
    const nextCycleAt =
      !sessionOpen && !isFutureTimestamp(rawNextCycleAt)
        ? fallbackNextCycle(marketKey)
        : normalizeFutureCycleTimestamp(rawNextCycleAt, cycleIntervalMinutes) || rawNextCycleAt;
    const hasLiveCycle = isFutureTimestamp(nextCycleAt);
    const trading =
      sessionOpen &&
      (hasLiveCycle || String(runtimeMode.runtime_mode || status.runtime_mode || "").trim().toUpperCase() === "REGULAR_CYCLE");
    const weeklyPnlEur = portfolioWeekPnlEur(portfolio);
    return {
      key: normalizeNoahMarketKey(marketKey),
      label: noahMarketLabel(marketKey),
      product: noahProductLabel(marketKey),
      trading,
      nextCycleAt,
      modeLabel: shortCycleMode(runtimeMode.execution_window_mode || runtimeMode.runtime_mode || session.session_state_raw || session.session_state),
      openTrades: Number((tradeActivity.counts || tradeActivity).open_positions || 0),
      closedTrades: Number((tradeActivity.counts || tradeActivity).closed_trades || 0),
      dailyPnlEur: Number(portfolio.daily_pnl_eur || 0),
      dailyPnlPct: Number(portfolio.daily_pnl_pct || 0),
      weeklyPnlEur,
      weeklyPnlPct: portfolioWeekPnlPct(portfolio, weeklyPnlEur),
      sessionOpen,
      hasLiveCycle
    };
  });

  const activeCycleRow =
    rows.find(row => row.key === normalizeNoahMarketKey(payload?.active_market) && row.nextCycleAt) ||
    rows.find(row => row.trading && row.nextCycleAt) ||
    rows.find(row => row.nextCycleAt) ||
    rows.find(row => row.key === normalizeNoahMarketKey(payload?.active_market)) ||
    rows.find(row => row.trading) ||
    rows[0] ||
    null;

  const combinedPortfolio = payload?.portfolio || {};
  const combinedTradeCounts = payload?.trade_activity?.counts || payload?.trade_activity || {};
  const weeklyEur = portfolioWeekPnlEur(combinedPortfolio) || rows.reduce((sum, row) => sum + row.weeklyPnlEur, 0);
  const weeklyPct = portfolioWeekPnlPct(combinedPortfolio, weeklyEur) || rows.reduce((sum, row) => sum + row.weeklyPnlPct, 0);

  return {
    checked_at: payload?.generated_at_utc || nowIso(),
    cycle: activeCycleRow
      ? {
          market_label: activeCycleRow.label,
          mode_label: activeCycleRow.modeLabel,
          next_cycle_at: activeCycleRow.nextCycleAt,
          trading: activeCycleRow.trading
        }
      : null,
    pnl: {
      daily_eur: Number(combinedPortfolio.daily_pnl_eur || rows.reduce((sum, row) => sum + row.dailyPnlEur, 0)),
      daily_pct: Number(combinedPortfolio.daily_pnl_pct || rows.reduce((sum, row) => sum + row.dailyPnlPct, 0)),
      weekly_eur: weeklyEur,
      weekly_pct: weeklyPct
    },
    trades_today: {
      open: Number(combinedTradeCounts.open_positions || rows.reduce((sum, row) => sum + row.openTrades, 0)),
      closed: Number(combinedTradeCounts.closed_trades || rows.reduce((sum, row) => sum + row.closedTrades, 0))
    },
    live: {
      configured_markets: Array.from(new Set(rows.map(row => row.label))),
      configured_products: Array.from(new Set(rows.map(row => row.product))),
      trading_markets: Array.from(new Set(rows.filter(row => row.trading).map(row => row.label))),
      trading_products: Array.from(new Set(rows.filter(row => row.trading).map(row => row.product)))
    }
  };
}

function liveTileStatus(summary) {
  if (summary?.error) {
    return "error";
  }
  const tradingMarkets = Array.isArray(summary?.live?.trading_markets) ? summary.live.trading_markets : [];
  if (tradingMarkets.length > 0) {
    return "ok";
  }
  return "idle";
}

async function probeNoahMonitor() {
  try {
    const baseUrl = getNoahMonitorBaseUrl();
    if (!baseUrl) {
      return makeNoahProbeFallback("Noah API Basis-URL fehlt");
    }
    const headers = buildAgentRemoteHeaders("CODEX_MONITOR_NOAH");
    const timeoutMs = parseOptionalNumber(process.env.CODEX_MONITOR_NOAH_MONITOR_TIMEOUT_MS, 90_000);
    try {
      const [statusCard, observerCard] = await Promise.all([
        fetchJson(createNoahMonitorUrl(baseUrl, "/api/v1/view/status-card", "combined"), { headers, timeoutMs }),
        fetchJson(createNoahMonitorUrl(baseUrl, "/api/v1/view/observer-card", "combined"), { headers, timeoutMs })
      ]);
      const summary = buildNoahSummary(statusCard, observerCard);
      if (summary.live?.configured_markets?.length) {
        return summary;
      }
    } catch {
      // Fall back to the legacy observer/live path below.
    }
    const observerLive = await fetchJson(
      createNoahMonitorUrl(baseUrl, "/api/v1/observer/live", "combined"),
      { headers, timeoutMs }
    );
    const marketKeys = Object.keys(observerLive?.markets || {});
    const statusEntries = await Promise.all(
      marketKeys.map(async marketKey => {
        try {
          const status = await fetchJson(
            createNoahMonitorUrl(baseUrl, "/api/v1/status/current", marketKey),
            { headers, timeoutMs }
          );
          return [marketKey, status];
        } catch {
          return [marketKey, null];
        }
      })
    );
    const summary = buildNoahSummaryFromObserverLive(observerLive, Object.fromEntries(statusEntries));
    if (!summary.live?.configured_markets?.length) {
      return makeNoahProbeFallback("Noah API lieferte keine Markt-Daten");
    }
    return summary;
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
      noahMonitorCache.cachedAt = Date.now();
      noahMonitorCache.result = result;
      noahMonitorInflight = null;
      return result;
    })
    .catch(error => {
      const fallback = makeNoahProbeFallback(error instanceof Error ? error.message : String(error));
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
  const updatedAt = summary?.checked_at || nowIso();
  const degraded = Boolean(summary?.stale_reason || Object.keys(summary?.warnings || {}).length);
  if (summary?.error) {
    const fallbackTiles = {
      cycle: {
        key: "cycle",
        label: "Noah Zyklus",
        status: "error",
        line1: "Keine Daten",
        line2: "--:--",
        footer: "Bridge Noah",
        updatedAt
      },
      weekly_pnl: {
        key: "weekly_pnl",
        label: "Wochen PnL",
        status: "error",
        line1: "Keine Daten",
        line2: "--%",
        footer: "Woche",
        updatedAt
      },
      daily_pnl: {
        key: "daily_pnl",
        label: "Tages PnL",
        status: "error",
        line1: "Keine Daten",
        line2: "--%",
        footer: "24h",
        updatedAt
      },
      trades_today: {
        key: "trades_today",
        label: "Trades Heute",
        status: "error",
        line1: "Open -",
        line2: "Close -",
        footer: "Heute",
        updatedAt
      },
      live_markets: {
        key: "live_markets",
        label: "Live Markt",
        status: "error",
        line1: "-",
        line2: blankTileLine(),
        footer: blankTileLine(),
        updatedAt
      }
    };
    return NOAH_TILE_ORDER.map(key => ({
      ...createDefaultNoahTile(key),
      ...(fallbackTiles[key] || {})
    }));
  }

  const cycle = summary?.cycle || {};
  const pnl = summary?.pnl || {};
  const trades = summary?.trades_today || {};
  const live = summary?.live || {};
  const nonTradingDay = isNoahNonTradingDay(summary);
  const cycleHasFutureTimer = isFutureTimestamp(cycle.next_cycle_at);
  const cycleStatus = cycle.trading ? (cycleHasFutureTimer ? "ok" : "warn") : degraded ? "warn" : "idle";
  const liveMarkets = compactCodes(live.trading_markets || live.markets);

  const tiles = {
    cycle: {
      key: "cycle",
      label: "Noah Zyklus",
      status: cycleStatus,
      line1: cycleHasFutureTimer ? formatCountdown(cycle.next_cycle_at) : "--:--",
      line2: blankTileLine(),
      footer: cycleHasFutureTimer ? "Naechste" : blankTileLine(),
      updatedAt
    },
    weekly_pnl: {
      key: "weekly_pnl",
      label: "Wochen PnL",
      status: pnlStatus(pnl.weekly_eur, degraded),
      line1: formatSignedEuro(pnl.weekly_eur),
      line2: formatSignedPercent(pnl.weekly_pct),
      footer: "Woche",
      updatedAt
    },
    daily_pnl: {
      key: "daily_pnl",
      label: "Tages PnL",
      status: nonTradingDay ? "idle" : pnlStatus(pnl.daily_eur, degraded),
      line1: nonTradingDay ? "Geschlossen" : formatSignedEuro(pnl.daily_eur),
      line2: nonTradingDay ? blankTileLine() : formatSignedPercent(pnl.daily_pct),
      footer: nonTradingDay ? "Heute" : "24h",
      updatedAt
    },
    trades_today: {
      key: "trades_today",
      label: "Trades Heute",
      status: nonTradingDay ? "idle" : degraded ? "warn" : "ok",
      line1: nonTradingDay ? "Geschlossen" : `Open ${Number(trades.open || 0)}`,
      line2: nonTradingDay ? blankTileLine() : `Close ${Number(trades.closed || 0)}`,
      footer: "Heute",
      updatedAt
    },
    live_markets: {
      key: "live_markets",
      label: "Live Markt",
      status: degraded && liveTileStatus(summary) !== "ok" ? "warn" : liveTileStatus(summary),
      line1: liveMarkets,
      line2: blankTileLine(),
      footer: blankTileLine(),
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
  const uiTick = setInterval(() => {
    void broadcastStateStream().catch(() => {});
  }, 1_000);
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
  server.on("close", () => {
    clearInterval(uiTick);
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
