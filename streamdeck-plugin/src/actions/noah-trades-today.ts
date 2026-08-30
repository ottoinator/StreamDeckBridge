import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.trades-today" })
export class NoahTradesTodayAction extends BaseNoahAction {
  constructor() {
    super("trades_today");
  }
}
