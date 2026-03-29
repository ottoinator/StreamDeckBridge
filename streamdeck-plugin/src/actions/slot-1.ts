import { action } from "@elgato/streamdeck";

import { BaseSlotAction } from "../slot-action";

@action({ UUID: "com.codex.stream-monitor.slot1" })
export class Slot1Action extends BaseSlotAction {
  constructor() {
    super(1);
  }
}
