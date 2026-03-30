import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.us-cycle" })
export class NoahUsCycleAction extends BaseNoahAction {
  constructor() {
    super("us_cycle");
  }
}
