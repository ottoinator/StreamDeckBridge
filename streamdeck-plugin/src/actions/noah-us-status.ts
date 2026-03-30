import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.us-status" })
export class NoahUsStatusAction extends BaseNoahAction {
  constructor() {
    super("us_status");
  }
}
