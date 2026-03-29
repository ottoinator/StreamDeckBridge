import { action } from "@elgato/streamdeck";

import { BaseSlotAction } from "../slot-action";

@action({ UUID: "com.codex.stream-monitor.slot4" })
export class Slot4Action extends BaseSlotAction {
  constructor() {
    super(4);
  }
}
