import type { KeyAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SingletonAction } from "@elgato/streamdeck";

import { defaultNoahTile, noahTileSvg, type NoahTileKey, type NoahTileState } from "./status";

type VisibleAction = KeyAction<Record<string, never>>;

export abstract class BaseNoahAction extends SingletonAction<Record<string, never>> {
  private static readonly visibleActions = new Map<NoahTileKey, Map<string, VisibleAction>>();
  private static currentTiles = [
    defaultNoahTile("xetra_status"),
    defaultNoahTile("xetra_cycle"),
    defaultNoahTile("us_status"),
    defaultNoahTile("us_cycle")
  ];

  readonly tileKey: NoahTileKey;

  protected constructor(tileKey: NoahTileKey) {
    super();
    this.tileKey = tileKey;
  }

  override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
    if (!ev.action.isKey()) {
      return;
    }
    const actions = BaseNoahAction.visibleActions.get(this.tileKey) || new Map<string, VisibleAction>();
    actions.set(ev.action.id, ev.action);
    BaseNoahAction.visibleActions.set(this.tileKey, actions);
    const tile = BaseNoahAction.currentTiles.find(item => item.key === this.tileKey) || defaultNoahTile(this.tileKey);
    await this.renderAction(ev.action, tile);
  }

  override async onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): Promise<void> {
    BaseNoahAction.visibleActions.get(this.tileKey)?.delete(ev.action.id);
  }

  static async updateTiles(tiles: NoahTileState[]): Promise<void> {
    BaseNoahAction.currentTiles = tiles;
    const updates = tiles.flatMap(tile => {
      const actions = BaseNoahAction.visibleActions.get(tile.key);
      if (!actions?.size) {
        return [];
      }
      return Array.from(actions.values()).map(action => BaseNoahAction.render(action, tile));
    });
    await Promise.all(updates);
  }

  private async renderAction(action: VisibleAction, tile: NoahTileState): Promise<void> {
    await BaseNoahAction.render(action, tile);
  }

  private static async render(action: VisibleAction, tile: NoahTileState): Promise<void> {
    await action.setTitle("");
    await action.setImage(noahTileSvg(tile));
  }
}
