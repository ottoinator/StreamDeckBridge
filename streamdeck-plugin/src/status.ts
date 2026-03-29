export type SlotStatus = "idle" | "running" | "needs_input" | "error" | "done";
export type AgentStatus = "online" | "attention" | "offline";

export type SlotState = {
  slot: number;
  label: string;
  status: SlotStatus;
  detail: string;
  updatedAt: string;
  startedAt?: string | null;
  threadOrTaskId: string;
  exitCode: number | null;
  pid?: number | null;
  heartbeatAt?: string | null;
  autodetected?: boolean;
};

export type AgentState = {
  name: "noah" | "carmen";
  label: string;
  status: AgentStatus;
  detail: string;
  updatedAt: string;
  lastSeenAt?: string | null;
  heartbeatAt?: string | null;
  activity?: boolean;
  blinkUntil?: string | null;
};

export type MonitorState = {
  slots: SlotState[];
  agents: AgentState[];
};

export const BRIDGE_URL = process.env.CODEX_MONITOR_URL || "http://127.0.0.1:4567/state";
export const POLL_INTERVAL_MS = 1_000;

const SLOT_STATUS_META: Record<SlotStatus, { title: string; color: string; dot: string }> = {
  idle: { title: "IDLE", color: "#5f6368", dot: "#d0d4d9" },
  running: { title: "LAEUFT", color: "#1565c0", dot: "#6ec6ff" },
  needs_input: { title: "INPUT", color: "#d4a017", dot: "#ffe082" },
  error: { title: "FEHLER", color: "#b3261e", dot: "#ff8a80" },
  done: { title: "FERTIG", color: "#2e7d32", dot: "#a5d6a7" }
};

const AGENT_STATUS_META: Record<AgentStatus, { title: string; color: string; dimColor: string; dot: string; dimDot: string }> = {
  online: { title: "ONLINE", color: "#14532d", dimColor: "#0b2e1a", dot: "#86efac", dimDot: "#1f6b3a" },
  attention: { title: "ACHTUNG", color: "#a16207", dimColor: "#6c4305", dot: "#fde047", dimDot: "#8a6708" },
  offline: { title: "OFFLINE", color: "#7f1d1d", dimColor: "#4d1010", dot: "#fca5a5", dimDot: "#5f1414" }
};

export function defaultSlot(slot: number): SlotState {
  return {
    slot,
    label: `Codex ${slot}`,
    status: "idle",
    detail: "Bereit",
    updatedAt: new Date(0).toISOString(),
    startedAt: null,
    threadOrTaskId: "",
    exitCode: null
  };
}

export function defaultAgent(name: AgentState["name"]): AgentState {
  return {
    name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    status: "offline",
    detail: "Offline",
    updatedAt: new Date(0).toISOString(),
    lastSeenAt: null,
    heartbeatAt: null,
    activity: false,
    blinkUntil: null
  };
}

export function offlineState(): MonitorState {
  return {
    slots: Array.from({ length: 4 }, (_, index) => ({
      ...defaultSlot(index + 1),
      status: "error",
      detail: "Bridge offline"
    })),
    agents: ["noah", "carmen"].map(name => ({
      ...defaultAgent(name as AgentState["name"]),
      status: "offline",
      detail: "Bridge offline"
    }))
  };
}

function normalizeAgentStatus(status: unknown): AgentStatus {
  const raw = String(status || "").toLowerCase();
  if (raw === "active") {
    return "online";
  }
  if (raw === "error") {
    return "attention";
  }
  if (raw === "idle") {
    return "offline";
  }
  return raw === "online" || raw === "attention" || raw === "offline" ? raw : "offline";
}

export function normalizeState(payload: unknown): MonitorState {
  const fallback = {
    slots: Array.from({ length: 4 }, (_, index) => defaultSlot(index + 1)),
    agents: ["noah", "carmen"].map(name => defaultAgent(name as AgentState["name"]))
  };

  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const source = payload as Partial<MonitorState>;
  const slots = Array.isArray(source.slots) ? source.slots : [];
  const agents = Array.isArray(source.agents) ? source.agents : [];

  return {
    slots: fallback.slots.map((item, index) => {
      const candidate = slots[index];
      if (!candidate || typeof candidate !== "object") {
        return item;
      }
      const slot = candidate as Partial<SlotState>;
      return {
        ...item,
        ...slot,
        slot: index + 1,
        label: String(slot.label || item.label),
        detail: String(slot.detail || item.detail),
        threadOrTaskId: String(slot.threadOrTaskId || ""),
        status: (["idle", "running", "needs_input", "error", "done"].includes(String(slot.status))
          ? slot.status
          : item.status) as SlotStatus
      };
    }),
    agents: fallback.agents.map((item, index) => {
      const candidate = agents[index];
      if (!candidate || typeof candidate !== "object") {
        return item;
      }
      const agent = candidate as Partial<AgentState>;
      return {
        ...item,
        ...agent,
        name: item.name,
        label: String(agent.label || item.label),
        detail: String(agent.detail || item.detail),
        status: normalizeAgentStatus(agent.status ?? item.status),
        lastSeenAt: typeof agent.lastSeenAt === "string" ? agent.lastSeenAt : item.lastSeenAt,
        heartbeatAt: typeof agent.heartbeatAt === "string" ? agent.heartbeatAt : item.heartbeatAt,
        activity: Boolean(agent.activity),
        blinkUntil: typeof agent.blinkUntil === "string" ? agent.blinkUntil : item.blinkUntil
      };
    })
  };
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapText(value: string, maxLineLength: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLineLength) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
      if (lines.length === maxLines) {
        return lines;
      }
    }
    current = word.length > maxLineLength ? `${word.slice(0, maxLineLength - 1)}…` : word;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.slice(0, maxLines);
}

function formatDuration(startedAt?: string | null): string {
  if (!startedAt) {
    return "";
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return "";
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isBlinkPhaseOn(): boolean {
  return Math.floor(Date.now() / 500) % 2 === 0;
}

function isAgentBlinking(agent: AgentState): boolean {
  if (agent.status === "attention") {
    return true;
  }
  if (agent.activity) {
    return true;
  }
  if (!agent.blinkUntil) {
    return false;
  }
  const until = Date.parse(agent.blinkUntil);
  return !Number.isNaN(until) && until > Date.now();
}

export function slotSvg(slot: SlotState): string {
  const meta = SLOT_STATUS_META[slot.status];
  const titleLines = wrapText(slot.label || `Codex ${slot.slot}`, 10, 2);
  const detailLines = wrapText(slot.detail || meta.title, 12, 2);
  const footer = meta.title;
  const runtime = slot.status === "running" && !slot.autodetected ? formatDuration(slot.startedAt || slot.updatedAt) : "";

  const titleSvg = titleLines
    .map((line, index) => `<text x="8" y="${14 + index * 10}" font-size="9" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");
  const detailSvg = detailLines
    .map((line, index) => `<text x="8" y="${40 + index * 9}" font-size="8" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" rx="12" fill="${meta.color}" />
      <rect x="5" y="5" width="62" height="62" rx="10" fill="rgba(255,255,255,0.08)" />
      <circle cx="58" cy="14" r="6" fill="${meta.dot}" />
      <text x="8" y="62" font-size="8" font-weight="700" fill="#ffffff">${escapeXml(footer)}</text>
      ${runtime ? `<text x="64" y="62" font-size="7" text-anchor="end" fill="#ffffff">${escapeXml(runtime)}</text>` : ""}
      ${titleSvg}
      ${detailSvg}
    </svg>
  `)}`;
}

export function agentSvg(agent: AgentState): string {
  const meta = AGENT_STATUS_META[agent.status];
  const titleLines = wrapText(agent.label, 10, 2);
  const detailLines = wrapText(agent.detail || meta.title, 12, 2);
  const blinkOn = isBlinkPhaseOn();
  const isBlinking = isAgentBlinking(agent);
  const backgroundColor = isBlinking && !blinkOn ? meta.dimColor : meta.color;
  const lampColor = isBlinking && !blinkOn ? meta.dimDot : meta.dot;
  const haloOpacity = isBlinking ? (blinkOn ? "0.34" : "0.05") : "0.18";
  const lampRadius = isBlinking ? (blinkOn ? 10 : 6) : 8;
  const footer = agent.status === "online" && isBlinking ? "AKTIV" : meta.title;

  const titleSvg = titleLines
    .map((line, index) => `<text x="36" y="${20 + index * 10}" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");
  const detailSvg = detailLines
    .map((line, index) => `<text x="36" y="${53 + index * 8}" text-anchor="middle" font-size="8" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" rx="12" fill="${backgroundColor}" />
      <rect x="4" y="4" width="64" height="64" rx="11" fill="rgba(255,255,255,0.06)" />
      <circle cx="36" cy="28" r="16" fill="rgba(255,255,255,${haloOpacity})" />
      <circle cx="36" cy="28" r="${lampRadius}" fill="${lampColor}" />
      <text x="36" y="66" text-anchor="middle" font-size="8" font-weight="700" fill="#ffffff">${escapeXml(footer)}</text>
      ${titleSvg}
      ${detailSvg}
    </svg>
  `)}`;
}
