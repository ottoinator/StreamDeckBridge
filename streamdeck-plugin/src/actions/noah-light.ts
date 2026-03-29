import { action } from "@elgato/streamdeck";

import { BaseAgentAction } from "../agent-action";

@action({ UUID: "com.codex.stream-monitor.agent.noah" })
export class NoahLightAction extends BaseAgentAction {
  constructor() {
    super("noah");
  }
}
