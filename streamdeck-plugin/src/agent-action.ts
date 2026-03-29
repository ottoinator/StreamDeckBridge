import type { KeyAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SingletonAction } from "@elgato/streamdeck";

import { agentSvg, defaultAgent, type AgentState } from "./status";

type VisibleAction = KeyAction<Record<string, never>>;

export abstract class BaseAgentAction extends SingletonAction<Record<string, never>> {
  private static readonly visibleActions = new Map<string, Map<string, VisibleAction>>();
  private static currentAgents = ["main", "noah", "carmen"].map(name => defaultAgent(name as AgentState["name"]));

  readonly agentName: AgentState["name"];

  protected constructor(agentName: AgentState["name"]) {
    super();
    this.agentName = agentName;
  }

  override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    if (!ev.action.isKey()) {
      return;
    }
    const actions = BaseAgentAction.visibleActions.get(this.agentName) || new Map<string, VisibleAction>();
    actions.set(ev.action.id, ev.action);
    BaseAgentAction.visibleActions.set(this.agentName, actions);
    const state = BaseAgentAction.currentAgents.find(agent => agent.name === this.agentName) || defaultAgent(this.agentName);
    await this.renderAction(ev.action, state);
  }

  override async onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): Promise<void> {
    BaseAgentAction.visibleActions.get(this.agentName)?.delete(ev.action.id);
  }

  static async updateAgents(agents: AgentState[]): Promise<void> {
    BaseAgentAction.currentAgents = agents;
    const updates = agents.flatMap(agent => {
      const actions = BaseAgentAction.visibleActions.get(agent.name);
      if (!actions?.size) {
        return [];
      }
      return Array.from(actions.values()).map(action => BaseAgentAction.render(action, agent));
    });
    await Promise.all(updates);
  }

  private async renderAction(action: VisibleAction, agent: AgentState): Promise<void> {
    await BaseAgentAction.render(action, agent);
  }

  private static async render(action: VisibleAction, agent: AgentState): Promise<void> {
    await action.setTitle("");
    await action.setImage(agentSvg(agent));
  }
}
