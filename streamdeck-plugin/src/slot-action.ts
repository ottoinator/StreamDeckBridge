import type { KeyAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SingletonAction } from "@elgato/streamdeck";

import { defaultSlot, slotSvg, type SlotState } from "./status";

type VisibleAction = KeyAction<Record<string, never>>;

export abstract class BaseSlotAction extends SingletonAction<Record<string, never>> {
  private static readonly visibleActions = new Map<number, Map<string, VisibleAction>>();
  private static currentSlots = Array.from({ length: 4 }, (_, index) => defaultSlot(index + 1));

  readonly slotNumber: number;

  protected constructor(slotNumber: number) {
    super();
    this.slotNumber = slotNumber;
  }

  override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    if (!ev.action.isKey()) {
      return;
    }
    const actions = BaseSlotAction.visibleActions.get(this.slotNumber) || new Map<string, VisibleAction>();
    actions.set(ev.action.id, ev.action);
    BaseSlotAction.visibleActions.set(this.slotNumber, actions);
    await this.renderAction(ev.action, BaseSlotAction.currentSlots[this.slotNumber - 1]);
  }

  override async onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): Promise<void> {
    BaseSlotAction.visibleActions.get(this.slotNumber)?.delete(ev.action.id);
  }

  static async updateSlots(slots: SlotState[]): Promise<void> {
    BaseSlotAction.currentSlots = slots;
    const updates = slots.flatMap(slot => {
      const actions = BaseSlotAction.visibleActions.get(slot.slot);
      if (!actions?.size) {
        return [];
      }
      return Array.from(actions.values()).map(action => BaseSlotAction.render(action, slot));
    });
    await Promise.all(updates);
  }

  private async renderAction(action: VisibleAction, slot: SlotState): Promise<void> {
    await BaseSlotAction.render(action, slot);
  }

  private static async render(action: VisibleAction, slot: SlotState): Promise<void> {
    await action.setTitle("");
    await action.setImage(slotSvg(slot));
  }
}
