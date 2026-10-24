import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("output/suit-record-art");
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
  for (const mode of ["fixture", "gemini"] as const) {
    test(`${mode} 花色集合与布局 ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const count of mode === "fixture" ? [0, 2, 4] : [2, 3, 4]) {
        await page.goto("/");
        await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
        await page.evaluate(async ({ count, mode }) => {
          const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
          await load("/src/table-screen-module.ts");
          const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
          await bootstrapContent({ fetch: window.fetch.bind(window) });
          const registry = await load("/src/core/abilities/registry.ts");
          const { SUITS } = await load("/src/core/blackjack/types.ts");
          const { createCard } = await load("/src/core/blackjack/card.ts");
          const { createMatch } = await load("/src/core/match/reducer.ts");
          const { loadCharacter } = await load("/src/content/characters/loader.ts");
          const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
          const { createPersistenceService } = await load("/src/persistence/factory.ts");
          const { mountGameRuntime } = await load("/src/match-screen.ts");
          const definition = { id: "example-suit-set", name: "花色集合", description: "通用花色集合展示", sourceKind: "talent", unlock: { type: "defeat-count", count: 1, label: "示例" }, primaryDomain: "gambler", tags: ["display"], activation: { type: "automatic" }, rules: [], displays: [
            { id: "suits", target: "rival", description: "表达式花色集合。", content: [{ type: "text", text: "花色集合" }, { type: "suit-record", values: Object.fromEntries(SUITS.map((suit: string, index: number) => [suit, { type: "constant", value: index < count }])) }] },
            { id: "number", target: "owner", description: "旧数值节点", content: [{ type: "text", text: "示例数值：" }, { type: "number", value: 42 }] }
          ] };
          if (mode === "fixture") registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, definition], registry.STATUS_DEFINITIONS, registry.ABILITY_CATALOG_VERSION);
          const character = await loadCharacter(mode === "gemini" ? "gemini" : "chatgpt");
          let match = createMatch("suit-set-art", { opponentId: character.id, opponentAiSkills: mode === "gemini" ? character.aiSkills : [], talentIds: mode === "fixture" ? [definition.id] : [] });
          if (mode === "gemini") {
            const suits = count === 2 ? ["spades", "hearts", "spades", "hearts"] : count === 3 ? ["spades", "hearts", "clubs", "hearts"] : SUITS;
            const cards = suits.map((suit: string, index: number) => createCard(suit, index % 2 === 0 ? "8" : "9", `table-${index}`));
            const player = { ...match.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false };
            const opponent = { ...match.opponent, hand: { cards: cards.slice(2) }, stood: false, busted: false };
            match = { ...match, player, opponent, round: { ...match.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
          }
          const repository = createPersistenceService();
          const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true; save.tutorialProgress.completedIds.push("adult-content-warning");
          await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));
          void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
        }, { count, mode });
        const board = page.locator(".status-chip-suit-record");
        await expect(board).toBeVisible();
        await expect(board.locator(".suit-record-cell")).toHaveCount(4);
        await expect(board.locator(".is-recorded")).toHaveCount(count);
        const positions = await board.locator(".suit-record-cell").evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().top)));
        expect(new Set(positions).size).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
        if (mode === "gemini") {
          if (count === 2) await expect(page.locator(".opponent-hand .hand-score-modifier")).toHaveCount(0);
          else await expect(page.locator(".opponent-hand .hand-score-modifier")).toHaveText(`+${count - 2}`);
          await expect(page.locator(".opponent-hand [data-card-surface=back]")).toHaveCount(1);
          mkdirSync(output, { recursive: true });
          const name = `gemini-${viewport.width}-${count}-suits`;
          await page.screenshot({ path: resolve(output, `${name}-table.png`) });
          await board.screenshot({ path: resolve(output, `${name}-board.png`) });
        } else await expect(page.locator("[data-display-actor=player] .status-chip")).toContainText("示例数值：42");
        await board.locator(".display-info-button").click();
        await expect(page.locator("#display-info-description")).toContainText(mode === "gemini" ? "包含暗牌和派生牌" : "表达式花色集合");
        await page.keyboard.press("Escape");
        await expect(page.locator("#display-info-dialog")).not.toBeVisible();
      }
    });
  }
}
