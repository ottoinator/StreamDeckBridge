export type SlotStatus = "idle" | "running" | "needs_input" | "error" | "done";

export type SlotState = {
  slot: number;
  label: string;
  status: SlotStatus;
  detail: string;
  updatedAt: string;
  threadOrTaskId: string;
  exitCode: number | null;
  pid?: number | null;
  heartbeatAt?: string | null;
};

export const BRIDGE_URL = process.env.CODEX_MONITOR_URL || "http://127.0.0.1:4567/slots";
export const POLL_INTERVAL_MS = 1_000;

const STATUS_META: Record<SlotStatus, { title: string; color: string; dot: string }> = {
  idle: { title: "IDLE", color: "#5f6368", dot: "#d0d4d9" },
  running: { title: "LAEUFT", color: "#1565c0", dot: "#6ec6ff" },
  needs_input: { title: "INPUT", color: "#d4a017", dot: "#ffe082" },
  error: { title: "FEHLER", color: "#b3261e", dot: "#ff8a80" },
  done: { title: "FERTIG", color: "#2e7d32", dot: "#a5d6a7" }
};

export function defaultSlot(slot: number): SlotState {
  return {
    slot,
    label: `Codex ${slot}`,
    status: "idle",
    detail: "Bereit",
    updatedAt: new Date(0).toISOString(),
    threadOrTaskId: "",
    exitCode: null
  };
}

export function offlineSlot(slot: number): SlotState {
  return {
    ...defaultSlot(slot),
    status: "error",
    label: `Codex ${slot}`,
    detail: "Bridge offline"
  };
}

export function normalizeSlots(slots: unknown): SlotState[] {
  const fallback = Array.from({ length: 4 }, (_, index) => defaultSlot(index + 1));
  if (!Array.isArray(slots)) {
    return fallback;
  }

  return fallback.map((item, index) => {
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
  });
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

export function slotSvg(slot: SlotState): string {
  const meta = STATUS_META[slot.status];
  const titleLines = wrapText(slot.label || `Codex ${slot.slot}`, 10, 2);
  const detailLines = wrapText(slot.detail || meta.title, 12, 2);
  const footer = meta.title;
  const updated = slot.updatedAt ? new Date(slot.updatedAt) : null;
  const updatedText =
    updated && !Number.isNaN(updated.valueOf())
      ? updated.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "--:--";

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
      <text x="53" y="62" font-size="7" text-anchor="end" fill="#ffffff">${escapeXml(updatedText)}</text>
      ${titleSvg}
      ${detailSvg}
    </svg>
  `)}`;
}
