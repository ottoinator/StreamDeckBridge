import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.xetra-cycle" })
export class NoahXetraCycleAction extends BaseNoahAction {
  constructor() {
    super("xetra_cycle");
  }
}
