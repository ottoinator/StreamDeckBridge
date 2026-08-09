import streamDeck from "@elgato/streamdeck";

import { UsRuntimeAction } from "./actions/noah-cycle";
import { WeatherPublicAction } from "./actions/noah-daily-pnl";
import { MlbEloV2Action } from "./actions/noah-weekly-pnl";
import { BaseNoahAction } from "./noah-action";
import { BRIDGE_URL, normalizeState, offlineState } from "./status";

streamDeck.logger.setLevel("info");
const BRIDGE_EVENTS_URL = process.env.CODEX_MONITOR_EVENTS_URL || new URL("/events", BRIDGE_URL).toString();

streamDeck.actions.registerAction(new UsRuntimeAction());
streamDeck.actions.registerAction(new MlbEloV2Action());
streamDeck.actions.registerAction(new WeatherPublicAction());

async function applyMonitorState(payload: unknown) {
  const state = normalizeState(payload);
  await BaseNoahAction.updateTiles(state.noahTiles);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function consumeEventStream(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Bridge stream has no body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchEvent = async (chunk: string) => {
    const lines = chunk.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (eventName !== "state" || dataLines.length === 0) {
      return;
    }

    await applyMonitorState(JSON.parse(dataLines.join("\n")));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      await dispatchEvent(rawEvent);
      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  throw new Error("Bridge stream disconnected");
}

async function connectBridgeStream() {
  while (true) {
    try {
      const response = await fetch(BRIDGE_EVENTS_URL, {
        headers: {
          Accept: "text/event-stream"
        }
      });
      if (!response.ok) {
        throw new Error(`Bridge HTTP ${response.status}`);
      }
      await consumeEventStream(response);
    } catch (error) {
      streamDeck.logger.error(`Bridge stream failed: ${error instanceof Error ? error.message : String(error)}`);
      await applyMonitorState(offlineState());
      await wait(1_000);
    }
  }
}

streamDeck.connect();
void connectBridgeStream();
