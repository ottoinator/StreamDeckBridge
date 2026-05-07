import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.live-markets" })
export class NoahLiveMarketsAction extends BaseNoahAction {
  constructor() {
    super("live_markets");
  }
}
