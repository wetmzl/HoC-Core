import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
  test(`点数集合展示与旧读数兼容 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const count of [0, 3, 13]) {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
      await page.evaluate(async (count) => {
        const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
        await load("/src/table-screen-module.ts");
        const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
        await bootstrapContent({ fetch: window.fetch.bind(window) });
        const registry = await load("/src/core/abilities/registry.ts");
        const { RANKS } = await load("/src/core/blackjack/types.ts");
        const { createMatch } = await load("/src/core/match/reducer.ts");
        const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
        const { createPersistenceService } = await load("/src/persistence/factory.ts");
        const { mountGameRuntime } = await load("/src/match-screen.ts");
        const status = { id: "example-rank-set", defaultDuration: "round", rules: [] };
        const definition = { id: "example-rank-display", name: "点数集合", description: "通用点数集合展示", sourceKind: "talent", unlock: { type: "defeat-count", count: 1, label: "示例" }, primaryDomain: "intelligence-officer", tags: ["display"], activation: { type: "automatic" }, rules: [], displays: [
          { id: "ranks", target: "rival", description: "记录中的点数集合及最近选择。", content: [{ type: "text", text: "点数集合" }, { type: "rank-record", target: "owner", statusDefinitionId: status.id }] },
          { id: "value", target: "owner", description: "旧数值节点。", content: [{ type: "text", text: "示例数值：" }, { type: "number", value: 42 }] }
        ] };
        registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, definition], [...registry.STATUS_DEFINITIONS, status], registry.ABILITY_CATALOG_VERSION);
        const base = createMatch("rank-display-layout", { opponentId: "chatgpt", talentIds: [definition.id] });
        const instance = base.abilities.instances.find((i: any) => i.definitionId === definition.id);
        const ranks = RANKS.slice(0, count);
        const statuses = count ? [{ statusDefinitionId: status.id, owner: "player", sourceInstanceId: instance.instanceId, stacks: 1, duration: "round", parameters: { ...Object.fromEntries(ranks.map((rank: string) => [`rank:${rank}`, true])), selectedRank: ranks.at(-1) }, createdAtSequence: base.abilities.sequence }] : [];
        const match = { ...base, round: { ...base.round, currentActor: "player" }, abilities: { ...base.abilities, statuses } };
        const repository = createPersistenceService();
        const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true; save.tutorialProgress.completedIds.push("adult-content-warning");
        await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));
        void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
      }, count);
      const board = page.locator(".status-chip-rank-record");
      await expect(board).toBeVisible();
      await expect(board.locator(".rank-record-cell")).toHaveCount(13);
      await expect(board.locator(".is-recorded")).toHaveCount(count);
      await expect(board.locator(".is-selected")).toHaveCount(count ? 1 : 0);
      await expect(page.locator("[data-display-actor=player] .status-chip")).toContainText("示例数值：42");
      const positions = await board.locator(".rank-record-cell").evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().top)));
      expect(new Set(positions.slice(0, 7)).size).toBe(1); expect(new Set(positions.slice(7)).size).toBe(1); expect(positions[7]).toBeGreaterThan(positions[0]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await board.locator(".display-info-button").focus(); await page.keyboard.press("Enter");
      await expect(page.locator("#display-info-description")).toHaveText("记录中的点数集合及最近选择。");
      await page.keyboard.press("Escape"); await expect(page.locator("#display-info-dialog")).not.toBeVisible();
    }
  });
}
