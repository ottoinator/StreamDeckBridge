import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.cycle" })
export class UsRuntimeAction extends BaseNoahAction {
  constructor() {
    super("us_runtime");
  }
}
