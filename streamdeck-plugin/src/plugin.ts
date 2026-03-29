import streamDeck from "@elgato/streamdeck";

import { CarmenLightAction } from "./actions/carmen-light";
import { MainLightAction } from "./actions/main-light";
import { NoahLightAction } from "./actions/noah-light";
import { Slot1Action } from "./actions/slot-1";
import { Slot2Action } from "./actions/slot-2";
import { Slot3Action } from "./actions/slot-3";
import { Slot4Action } from "./actions/slot-4";
import { BaseAgentAction } from "./agent-action";
import { BaseSlotAction } from "./slot-action";
import { BRIDGE_URL, normalizeState, offlineState, POLL_INTERVAL_MS } from "./status";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Slot1Action());
streamDeck.actions.registerAction(new Slot2Action());
streamDeck.actions.registerAction(new Slot3Action());
streamDeck.actions.registerAction(new Slot4Action());
streamDeck.actions.registerAction(new MainLightAction());
streamDeck.actions.registerAction(new NoahLightAction());
streamDeck.actions.registerAction(new CarmenLightAction());

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
      BaseAgentAction.updateAgents(state.agents)
    ]);
  } catch (error) {
    streamDeck.logger.error(`Bridge poll failed: ${error instanceof Error ? error.message : String(error)}`);
    const state = offlineState();
    await Promise.all([
      BaseSlotAction.updateSlots(state.slots),
      BaseAgentAction.updateAgents(state.agents)
    ]);
  }
}

streamDeck.connect();
void pollBridge();
setInterval(() => {
  void pollBridge();
}, POLL_INTERVAL_MS);
