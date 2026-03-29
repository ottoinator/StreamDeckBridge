import streamDeck from "@elgato/streamdeck";

import { Slot1Action } from "./actions/slot-1";
import { Slot2Action } from "./actions/slot-2";
import { Slot3Action } from "./actions/slot-3";
import { Slot4Action } from "./actions/slot-4";
import { BaseSlotAction } from "./slot-action";
import { BRIDGE_URL, normalizeSlots, offlineSlot, POLL_INTERVAL_MS } from "./status";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Slot1Action());
streamDeck.actions.registerAction(new Slot2Action());
streamDeck.actions.registerAction(new Slot3Action());
streamDeck.actions.registerAction(new Slot4Action());

async function pollBridge() {
  try {
    const response = await fetch(BRIDGE_URL, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}`);
    }
    const payload = await response.json();
    await BaseSlotAction.updateSlots(normalizeSlots(payload));
  } catch (error) {
    streamDeck.logger.error(`Bridge poll failed: ${error instanceof Error ? error.message : String(error)}`);
    await BaseSlotAction.updateSlots(Array.from({ length: 4 }, (_, index) => offlineSlot(index + 1)));
  }
}

streamDeck.connect();
void pollBridge();
setInterval(() => {
  void pollBridge();
}, POLL_INTERVAL_MS);
