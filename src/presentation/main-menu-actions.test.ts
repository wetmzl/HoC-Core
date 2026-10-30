import { expect, it, vi } from "vitest";
import { builtinMainMenuActions, collectMainMenuActions } from "./main-menu-actions";
import { renderLobbyMarkup } from "../lobby-screen-module";
import { createDefaultSave } from "../persistence/boot";
import type { PluginUiAction } from "../content/packages/plugin-ui";
import type { MainMenuAction } from "./main-menu-actions";
import { getCharacterMetadata } from "../content/characters";

it("keeps built-in modules and package-local IDs ordered without routing collisions", async () => {
  const open = vi.fn(async () => {});
  const action: PluginUiAction = { id: "history", slot: "main-menu.secondary", label: "目录", order: 20, mount: () => ({ dispose() {} }) };
  const second = { ...action, label: "另一个目录" };
  const builtin = builtinMainMenuActions({ historyCount: 2, openDialog: vi.fn(), openSkills: vi.fn(), openHistory: vi.fn() });
  const actions = collectMainMenuActions(builtin, [{ uiActions: [action] }, { uiActions: [second] }], open);
  expect(actions.filter(a => a.slot === "main-menu.secondary").map(a => a.label)).toEqual(["玩法说明", "技能与天赋", "目录", "另一个目录", "历史记录"]);
  expect(new Set(actions.map(a => a.id)).size).toBe(actions.length);
  await actions.find(a => a.label === "另一个目录")!.activate();
  expect(open).toHaveBeenCalledExactlyOnceWith(second);
});
it("escapes all plugin button text and does not render menu slots in character selection", () => {
  const actions = collectMainMenuActions([], [{ uiActions: [{ id: "test", slot: "main-menu.tools", label: '<img src=x onerror="alert(1)">', icon: '<b>', mount: () => ({ dispose() {} }) }] }], async () => {});
  const view = { save: createDefaultSave(), menuActions: actions, guests: [], defeated: [], visibleDefeated: [], defeatedRemaining: 0 };
  const menu = renderLobbyMarkup({ ...view, layer: "menu" });
  expect(menu).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  expect(menu).toContain('&lt;b&gt;');
  expect(menu).not.toContain('<img src=x');
  expect(renderLobbyMarkup({ ...view, layer: "characters" })).not.toContain('data-ui-action');
});
it("uses portrait capabilities instead of CSS names and distinguishes flows sharing an opponent", () => {
  const character = getCharacterMetadata("claude")!;
  const actions: MainMenuAction[] = [
    { id: "ordinary-tool", slot: "main-menu.secondary", label: "Menu tool", className: "lobby-boss-entry", activate() {} },
    { id: "trial-one", slot: "main-menu.secondary", label: "First trial", portraitEntry: { character, current: 1, required: 1, unlocked: true, label: "First trial", subtitle: "First route" }, activate() {} },
    { id: "trial-two", slot: "main-menu.secondary", label: "Second trial", portraitEntry: { character, current: 1, required: 1, unlocked: true, label: "Second trial", subtitle: "Second route" }, activate() {} }
  ];
  const view = { save: createDefaultSave(), menuActions: actions, guests: [], defeated: [], visibleDefeated: [], defeatedRemaining: 0 };
  const menu = renderLobbyMarkup({ ...view, layer: "menu" });
  expect(menu).toContain('data-ui-action="ordinary-tool"');
  expect(menu).not.toContain('data-ui-action="trial-one"');
  const cards = renderLobbyMarkup({ ...view, layer: "characters" });
  expect(cards).toContain("<h2>First trial</h2><p>First route</p>");
  expect(cards).toContain("<h2>Second trial</h2><p>Second route</p>");
  expect(cards).not.toContain('data-ui-action="ordinary-tool"');
});
