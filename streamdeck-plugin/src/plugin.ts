import streamDeck from "@elgato/streamdeck";

import { CarmenLightAction } from "./actions/carmen-light";
import { NoahLightAction } from "./actions/noah-light";
import { NoahUsCycleAction } from "./actions/noah-us-cycle";
import { NoahUsStatusAction } from "./actions/noah-us-status";
import { NoahXetraCycleAction } from "./actions/noah-xetra-cycle";
import { NoahXetraStatusAction } from "./actions/noah-xetra-status";
import { Slot1Action } from "./actions/slot-1";
import { Slot2Action } from "./actions/slot-2";
import { Slot3Action } from "./actions/slot-3";
import { Slot4Action } from "./actions/slot-4";
import { BaseAgentAction } from "./agent-action";
import { BaseNoahAction } from "./noah-action";
import { BaseSlotAction } from "./slot-action";
import { BRIDGE_URL, normalizeState, offlineState, POLL_INTERVAL_MS } from "./status";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Slot1Action());
streamDeck.actions.registerAction(new Slot2Action());
streamDeck.actions.registerAction(new Slot3Action());
streamDeck.actions.registerAction(new Slot4Action());
streamDeck.actions.registerAction(new NoahLightAction());
streamDeck.actions.registerAction(new CarmenLightAction());
streamDeck.actions.registerAction(new NoahXetraStatusAction());
streamDeck.actions.registerAction(new NoahXetraCycleAction());
streamDeck.actions.registerAction(new NoahUsStatusAction());
streamDeck.actions.registerAction(new NoahUsCycleAction());

async function pollBridge() {
  try {
    const response = await fetch(BRIDGE_URL, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}`);
    }
    const payload = await response.json();
    const state = normalizeState(payload);
    await Promise.all([
      BaseSlotAction.updateSlots(state.slots),
      BaseAgentAction.updateAgents(state.agents),
      BaseNoahAction.updateTiles(state.noahTiles)
    ]);
  } catch (error) {
    streamDeck.logger.error(`Bridge poll failed: ${error instanceof Error ? error.message : String(error)}`);
    const state = offlineState();
    await Promise.all([
      BaseSlotAction.updateSlots(state.slots),
      BaseAgentAction.updateAgents(state.agents),
      BaseNoahAction.updateTiles(state.noahTiles)
    ]);
  }
}

streamDeck.connect();
void pollBridge();
setInterval(() => {
  void pollBridge();
}, POLL_INTERVAL_MS);
