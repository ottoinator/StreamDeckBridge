import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.weekly-pnl" })
export class MlbEloV2Action extends BaseNoahAction {
  constructor() {
    super("mlb_elo_v2");
  }
}
