import type { PluginUiAction, PluginUiSlot } from "../content/packages/plugin-ui";
import type { PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { LOBBY_INFO_PAGES } from "../content/lobby-info";
import { achievementTrophy } from "./achievement-ui";

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
  /** Host-only placement below the header; plugin slots stay unchanged. */
  readonly toolPlacement?: "aside";
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
  openNotebook?(): Promise<void>;
}): MainMenuAction[] {
  return [
    { id: "rules", slot: "main-menu.secondary", label: "玩法说明", order: 10, attributes: { "data-open": "rules" }, activate: () => options.openDialog("rules") },
    { id: "skills", slot: "main-menu.secondary", label: "技能与天赋", order: 20, attributes: { "data-open": "skills" }, activate: options.openSkills },
    { id: "history", slot: "main-menu.secondary", label: "历史记录", description: `${options.historyCount} 局`, order: 30, attributes: { "data-open-history": "" }, activate: options.openHistory },
    ...LOBBY_INFO_PAGES.map((page, index): MainMenuAction => ({
      id: page.id, slot: "main-menu.tools", label: `打开${page.buttonLabel}`, order: 10 + index * 10,
      attributes: { "data-open": page.id }, className: `lobby-${page.id}-button`,
      iconMarkup: '<span class="lobby-info-letter" aria-hidden="true">i</span>',
      activate: () => options.openDialog(page.id)
    })),
    { id: "achievements", slot: "main-menu.tools", label: "打开成就", description: "查看成就", className: "lobby-achievements-button", iconMarkup: achievementTrophy, order: 35, activate: () => options.openDialog("achievements") },
    { id: "settings", slot: "main-menu.tools", label: "打开设置", className: "lobby-settings-button", icon: "⚙", order: 40, attributes: { "data-open": "settings" }, activate: () => options.openDialog("settings") },
    ...(options.openNotebook ? [{ id: "notebook", slot: "main-menu.tools" as const, label: "笔记本", description: "剧情档案馆与个人记录", order: 45,
      attributes: { "data-open-notebook": "" }, className: "lobby-notebook-button",
      iconMarkup: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5M12 16h3"/></svg>',
      activate: options.openNotebook }] : [])
  ];
}
