import { action } from "@elgato/streamdeck";

import { BaseSlotAction } from "../slot-action";

@action({ UUID: "com.codex.stream-monitor.slot2" })
export class Slot2Action extends BaseSlotAction {
  constructor() {
    super(2);
  }
}
