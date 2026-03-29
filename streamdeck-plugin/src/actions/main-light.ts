import { action } from "@elgato/streamdeck";

import { BaseAgentAction } from "../agent-action";

@action({ UUID: "com.codex.stream-monitor.agent.main" })
export class MainLightAction extends BaseAgentAction {
  constructor() {
    super("main");
  }
}
