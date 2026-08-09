import { action } from "@elgato/streamdeck";

import { BaseNoahAction } from "../noah-action";

@action({ UUID: "com.codex.stream-monitor.noah.daily-pnl" })
export class WeatherPublicAction extends BaseNoahAction {
  constructor() {
    super("weather_public");
  }
}
