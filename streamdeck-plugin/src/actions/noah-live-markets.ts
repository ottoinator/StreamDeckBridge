import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";
import { cycleNoahMarketView } from "../status";

@action({ UUID: "com.codex.stream-monitor.noah.live-markets" })
export class NoahLiveMarketsAction extends BaseNoahAction {
  constructor() {
    super("live_markets");
  }

  override async onKeyUp(_ev: KeyUpEvent<Record<string, never>>): Promise<void> {
    await cycleNoahMarketView();
  }
}
