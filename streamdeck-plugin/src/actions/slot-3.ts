import { action } from "@elgato/streamdeck";

import { BaseSlotAction } from "../slot-action";

@action({ UUID: "com.codex.stream-monitor.slot3" })
export class Slot3Action extends BaseSlotAction {
  constructor() {
    super(3);
  }
}
