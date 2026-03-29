import { action } from "@elgato/streamdeck";

import { BaseAgentAction } from "../agent-action";

@action({ UUID: "com.codex.stream-monitor.agent.carmen" })
export class CarmenLightAction extends BaseAgentAction {
  constructor() {
    super("carmen");
  }
}
