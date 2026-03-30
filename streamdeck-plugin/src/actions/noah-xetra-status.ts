import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.xetra-status" })
export class NoahXetraStatusAction extends BaseNoahAction {
  constructor() {
    super("xetra_status");
  }
}
