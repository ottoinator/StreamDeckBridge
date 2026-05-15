#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const VALID_ACTIONS = new Set([
  "register",
  "progress",
  "heartbeat",
  "needs_input",
  "done",
  "error",
  "clear",
  "watch-start",
  "watch-stop",
  "watch-loop"
]);

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function dataDir() {
  return process.env.CODEX_MONITOR_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "CodexStreamDeckMonitor");
}

function watcherDir() {
  return path.join(dataDir(), "watchers");
}

function watcherStatePath(threadId) {
  return path.join(watcherDir(), `${threadId}.json`);
}

function sessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

function defaultLabel() {
  return path.basename(process.cwd()) || "Codex Chat";
}

function normalizeThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId) {
    throw new Error("CODEX_THREAD_ID fehlt. Setze --thread explizit oder starte das Script in einem Codex-Chat.");
  }
  return threadId;
}

function threadUri(baseUrl, threadId) {
  return `${String(baseUrl).replace(/\/+$/, "")}/threads/${encodeURIComponent(threadId)}`;
}

async function postJson(uri, body) {
  const response = await fetch(uri, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}: ${text.trim() || response.statusText}`);
  }
  return parsed;
}

async function readWatcherState(threadId) {
  try {
    return JSON.parse(await readFile(watcherStatePath(threadId), "utf8"));
  } catch {
    return null;
  }
}

async function writeWatcherState(threadId, patch) {
  const existing = (await readWatcherState(threadId)) || {};
  const next = {
    threadId,
    label: patch.label ?? existing.label ?? "",
    detail: patch.detail ?? existing.detail ?? "",
    slot: patch.slot ?? existing.slot ?? null,
    intervalSeconds: patch.intervalSeconds ?? existing.intervalSeconds ?? 20,
    idleDoneSeconds: patch.idleDoneSeconds ?? existing.idleDoneSeconds ?? 0,
    lastActivityAt: patch.lastActivityAt ?? existing.lastActivityAt ?? nowIso(),
    pid: patch.pid ?? existing.pid ?? null,
    updatedAt: nowIso()
  };
  await mkdir(watcherDir(), { recursive: true });
  await writeFile(watcherStatePath(threadId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function removeWatcherState(threadId) {
  await rm(watcherStatePath(threadId), { force: true });
}

function isProcessRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function stopWatcher(threadId) {
  const state = await readWatcherState(threadId);
  await removeWatcherState(threadId);
  if (state?.pid && isProcessRunning(state.pid)) {
    try {
      process.kill(Number(state.pid), "SIGTERM");
    } catch {
    }
  }
}

async function listJsonlFiles(root) {
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
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }));
  }
  await walk(root);
  return files;
}

async function findSessionLog(threadId) {
  if (!existsSync(sessionsRoot())) {
    return null;
  }
  const files = await listJsonlFiles(sessionsRoot());
  const matches = files.filter(file => path.basename(file).includes(threadId));
  if (!matches.length) {
    return null;
  }
  const stats = await Promise.all(matches.map(async file => {
    try {
      const fileStat = await stat(file);
      return { file, mtimeMs: fileStat.mtimeMs };
    } catch {
      return { file, mtimeMs: 0 };
    }
  }));
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0].file;
}

async function readTurnState(sessionLogPath) {
  if (!sessionLogPath) {
    return null;
  }
  let raw = "";
  try {
    raw = await readFile(sessionLogPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.trimEnd().split(/\r?\n/).slice(-250);
  let lastUserMessageAt = null;
  let lastFinalAnswerAt = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = Date.parse(String(entry.timestamp || ""));
    if (Number.isNaN(timestamp)) {
      continue;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
      lastUserMessageAt = Math.max(lastUserMessageAt ?? 0, timestamp);
      continue;
    }
    if (
      entry.type === "response_item" &&
      entry.payload?.type === "message" &&
      entry.payload?.role === "assistant" &&
      entry.payload?.phase === "final_answer"
    ) {
      lastFinalAnswerAt = Math.max(lastFinalAnswerAt ?? 0, timestamp);
    }
  }
  return { lastUserMessageAt, lastFinalAnswerAt };
}

async function startWatcher({ threadId, label, detail, baseUrl, slot, intervalSeconds, idleDoneSeconds }) {
  const existing = await readWatcherState(threadId);
  if (existing?.pid && isProcessRunning(existing.pid)) {
    return writeWatcherState(threadId, {
      label,
      detail,
      slot: slot || existing.slot || null,
      intervalSeconds,
      idleDoneSeconds,
      lastActivityAt: nowIso()
    });
  }

  await writeWatcherState(threadId, { label, detail, slot: slot || null, intervalSeconds, idleDoneSeconds, lastActivityAt: nowIso() });
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    "watch-loop",
    "--thread",
    threadId,
    "--bridge-url",
    baseUrl,
    "--interval-seconds",
    String(intervalSeconds),
    "--idle-done-seconds",
    String(idleDoneSeconds)
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  return writeWatcherState(threadId, { label, detail, slot: slot || null, intervalSeconds, idleDoneSeconds, pid: child.pid });
}

async function watchLoop({ threadId, baseUrl, intervalSeconds, idleDoneSeconds }) {
  const uri = threadUri(baseUrl, threadId);
  let sessionLogPath = null;
  while (true) {
    const state = await readWatcherState(threadId);
    if (!state) {
      return;
    }
    if (!sessionLogPath || !existsSync(sessionLogPath)) {
      sessionLogPath = await findSessionLog(threadId);
    }
    const turnState = await readTurnState(sessionLogPath);
    if (
      turnState?.lastFinalAnswerAt &&
      (!turnState.lastUserMessageAt || turnState.lastFinalAnswerAt > turnState.lastUserMessageAt)
    ) {
      const body = {
        status: "done",
        exitCode: 0,
        source: "codex-app",
        label: state.label || defaultLabel(),
        detail: "Antwort gesendet"
      };
      if (state.slot) body.slot = Number(state.slot);
      try {
        await postJson(uri, body);
      } catch {
      }
      await removeWatcherState(threadId);
      return;
    }

    const idleSeconds = Number(state.idleDoneSeconds || idleDoneSeconds || 0);
    const lastActivityMs = Date.parse(String(state.lastActivityAt || ""));
    if (idleSeconds > 0 && !Number.isNaN(lastActivityMs) && Date.now() - lastActivityMs >= idleSeconds * 1000) {
      const body = {
        status: "done",
        exitCode: 0,
        source: "codex-app",
        label: state.label || defaultLabel(),
        detail: "Warten auf Nachricht"
      };
      if (state.slot) body.slot = Number(state.slot);
      try {
        await postJson(uri, body);
      } catch {
      }
      await removeWatcherState(threadId);
      return;
    }

    const body = {
      status: "running",
      heartbeat: true,
      source: "codex-app",
      label: state.label || defaultLabel(),
      detail: state.detail || "Codex arbeitet"
    };
    if (state.slot) body.slot = Number(state.slot);
    try {
      await postJson(`${uri}/heartbeat`, body);
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(intervalSeconds || 20)) * 1000));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args.action || args._[0] || "heartbeat").trim();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Unknown action: ${action}`);
  }

  const threadId = normalizeThreadId(args.thread || args["thread-id"] || process.env.CODEX_THREAD_ID);
  const label = String(args.label || defaultLabel()).trim();
  const detail = String(args.detail || "").trim();
  const baseUrl = String(args["bridge-url"] || process.env.CODEX_MONITOR_BASE_URL || "http://127.0.0.1:4567");
  const slot = Number(args.slot || 0);
  const exitCode = Number(args["exit-code"] || args.exitCode || 1);
  const intervalSeconds = Number(args["interval-seconds"] || args.intervalSeconds || 20);
  const idleDoneSeconds = Number(args["idle-done-seconds"] || args.idleDoneSeconds || process.env.CODEX_MONITOR_THREAD_IDLE_DONE_SECONDS || 0);
  const uri = threadUri(baseUrl, threadId);

  if (action === "watch-start") {
    console.log(JSON.stringify(await startWatcher({ threadId, label, detail, baseUrl, slot, intervalSeconds, idleDoneSeconds }), null, 2));
    return;
  }
  if (action === "watch-stop") {
    await stopWatcher(threadId);
    console.log(JSON.stringify({ threadId, watcher: "stopped" }, null, 2));
    return;
  }
  if (action === "watch-loop") {
    await watchLoop({ threadId, baseUrl, intervalSeconds, idleDoneSeconds });
    return;
  }

  const body = { label, source: "codex-app" };
  if (detail) body.detail = detail;
  if (slot > 0) body.slot = slot;

  let targetUri = uri;
  let startWatch = false;
  let stopWatch = false;

  if (action === "register") {
    body.status = "running";
    body.heartbeat = true;
    body.startedAt = nowIso();
    targetUri = `${uri}/heartbeat`;
    startWatch = Boolean(args.watch);
  } else if (action === "progress" || action === "heartbeat") {
    body.status = "running";
    body.heartbeat = true;
    targetUri = `${uri}/heartbeat`;
    startWatch = Boolean(args.watch);
  } else if (action === "needs_input") {
    body.status = "needs_input";
    body.detail ||= "Rueckfrage offen";
    stopWatch = true;
  } else if (action === "done") {
    body.status = "done";
    body.exitCode = 0;
    body.detail ||= "Erfolgreich beendet";
    stopWatch = true;
  } else if (action === "error") {
    body.status = "error";
    body.exitCode = exitCode;
    body.detail ||= "Fehler";
    stopWatch = true;
  } else if (action === "clear") {
    body.clear = true;
    stopWatch = true;
  }

  if (stopWatch) {
    await stopWatcher(threadId);
  }

  const response = await postJson(targetUri, body);
  if (action === "register" || action === "progress" || action === "heartbeat") {
    await writeWatcherState(threadId, {
      label,
      detail: body.detail || response.detail || "Codex arbeitet",
      slot: response.slot || slot || null,
      intervalSeconds,
      idleDoneSeconds,
      lastActivityAt: nowIso()
    });
    if (startWatch) {
      await startWatcher({
        threadId,
        label,
        detail: body.detail || response.detail || "Codex arbeitet",
        baseUrl,
        slot: response.slot || slot || 0,
        intervalSeconds,
        idleDoneSeconds
      });
    }
  }
  console.log(JSON.stringify(response, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
