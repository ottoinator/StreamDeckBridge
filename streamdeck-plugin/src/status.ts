export type SlotStatus = "idle" | "running" | "needs_input" | "error" | "done";
export type AgentStatus = "idle" | "active" | "error";

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

const AGENT_STATUS_META: Record<AgentStatus, { title: string; color: string; dot: string }> = {
  idle: { title: "INAKTIV", color: "#4b5563", dot: "#9ca3af" },
  active: { title: "AKTIV", color: "#1b5e20", dot: "#8bc34a" },
  error: { title: "STOERUNG", color: "#7f1d1d", dot: "#ef9a9a" }
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
    status: "idle",
    detail: "Inaktiv",
    updatedAt: new Date(0).toISOString(),
    lastSeenAt: null
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
      status: "error",
      detail: "Bridge offline"
    }))
  };
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
        status: (["idle", "active", "error"].includes(String(agent.status))
          ? agent.status
          : item.status) as AgentStatus
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

  const titleSvg = titleLines
    .map((line, index) => `<text x="36" y="${20 + index * 10}" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");
  const detailSvg = detailLines
    .map((line, index) => `<text x="36" y="${53 + index * 8}" text-anchor="middle" font-size="8" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" rx="12" fill="${meta.color}" />
      <circle cx="36" cy="28" r="14" fill="rgba(255,255,255,0.14)" />
      <circle cx="36" cy="28" r="8" fill="${meta.dot}" />
      <text x="36" y="66" text-anchor="middle" font-size="8" font-weight="700" fill="#ffffff">${escapeXml(meta.title)}</text>
      ${titleSvg}
      ${detailSvg}
    </svg>
  `)}`;
}
