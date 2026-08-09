import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.weekly-pnl" })
export class NoahWeeklyPnlAction extends BaseNoahAction {
  constructor() {
    super("weekly_pnl");
  }
}
