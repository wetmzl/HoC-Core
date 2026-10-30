import type { PluginUiAction, PluginUiSlot } from "../content/packages/plugin-ui";
import type { PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { LOBBY_INFO_PAGES } from "../content/lobby-info";

export interface MainMenuAction {
  readonly id: string;
  readonly slot: PluginUiSlot;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly order?: number;
  /** Internal compatibility hooks; never populated from plugin data. */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly iconMarkup?: string;
  readonly className?: string;
  /** A portrait with unlock progress projected by the host; plugins cannot supply this view. */
  readonly portraitEntry?: { readonly character: import("../content/characters").CharacterMetadata; readonly current: number; readonly required: number; readonly unlocked: boolean; readonly label?: string; readonly subtitle?: string };
  activate(): void | Promise<void>;
}

export function collectMainMenuActions(builtin: readonly MainMenuAction[], contributions: readonly PluginRuntimeContribution[], openPage: (action: PluginUiAction) => Promise<void>): MainMenuAction[] {
  return [...builtin, ...contributions.flatMap((contribution, index) => (contribution.uiActions ?? []).map(action => ({
    id: `extension:${index}:${action.id}`, slot: action.slot, label: action.label,
    description: action.description, icon: action.icon, order: action.order,
    activate: () => openPage(action)
  })))].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Built-in modules contribute through the same slots as external pages. */
export function builtinMainMenuActions(options: {
  historyCount: number;
  openDialog(id: string): void;
  openSkills(): void;
  openHistory(): Promise<void>;
}): MainMenuAction[] {
  return [
    { id: "rules", slot: "main-menu.secondary", label: "玩法说明", order: 10, attributes: { "data-open": "rules" }, activate: () => options.openDialog("rules") },
    { id: "skills", slot: "main-menu.secondary", label: "技能与天赋", order: 20, attributes: { "data-open": "skills" }, activate: options.openSkills },
    { id: "history", slot: "main-menu.secondary", label: "历史记录", description: `${options.historyCount} 局`, order: 30, attributes: { "data-open-history": "" }, activate: options.openHistory },
    ...LOBBY_INFO_PAGES.map((page, index): MainMenuAction => ({
      id: page.id, slot: "main-menu.tools", label: `打开${page.buttonLabel}`, order: 10 + index * 10,
      attributes: { "data-open": page.id }, className: `lobby-${page.id}-button`,
      iconMarkup: page.id === "about" ? '<span class="lobby-info-letter" aria-hidden="true">i</span>' : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${page.id === "community" ? "M4 5.5h16v10H9l-5 3.5V5.5Z" : "M12 20S4 15.3 4 9.4C4 6.4 7.7 4.8 10 7.2l2 2 2-2c2.3-2.4 6-0.8 6 2.2C20 15.3 12 20 12 20Z"}" /></svg>`,
      activate: () => options.openDialog(page.id)
    })),
    { id: "settings", slot: "main-menu.tools", label: "打开设置", className: "lobby-settings-button", icon: "⚙", order: 40, attributes: { "data-open": "settings" }, activate: () => options.openDialog("settings") }
  ];
}
