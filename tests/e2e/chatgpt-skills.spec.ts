import { expect, test } from "@playwright/test";

for (const width of [390, 320]) for (const completedRounds of [0, 2]) {
  test(`ChatGPT 跟随 Hit、RESET 和存档 ${width} / 已完成 ${completedRounds} 回合`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.evaluate(async (completedRounds) => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      await load("/src/table-screen-module.ts");
      const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
      await bootstrapContent({ fetch: window.fetch.bind(window) });
      const { loadCharacter } = await load("/src/content/characters/loader.ts");
      const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
      const { createCard } = await load("/src/core/blackjack/card.ts");
      const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
      const { createPersistenceService } = await load("/src/persistence/factory.ts");
      const { mountGameRuntime } = await load("/src/match-screen.ts");
      const character = await loadCharacter("chatgpt");
      let base = createMatch("chatgpt-ui", { opponentId: "chatgpt", opponentAiSkills: character.aiSkills, aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
      for (let i = 0; i < completedRounds; i++) base = gameReducer({ ...base, playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
      const ranks = ["2", "3", "10", "9", "2", "K", "2", "3", "K", "K", "A", "K", ...Array(40).fill("2")];
      const cards = ranks.map((rank, index) => createCard("spades", rank, `chatgpt-ui-${index}`));
      const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, bustLimit: undefined };
      const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, bustLimit: undefined };
      const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, phase: "turns", currentActor: "player" }, history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }] };
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
      const repo = createPersistenceService();
      await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
      void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
    }, completedRounds);
    const warning = page.locator("#adult-content-warning");
    if (await warning.isVisible()) await warning.getByRole("button", { name: "我已成年并继续" }).click();
    const chip = page.locator('[data-display-actor="opponent"] .status-chip');
    await expect(chip).toContainText(`RESET ： ${completedRounds}`);
    await page.screenshot({ path: testInfo.outputPath(`reset-ready-${width}.png`) });
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    if (completedRounds === 0) {
      await expect(chip).toContainText("RESET ： 0");
      await expect(page.locator('main.table-shell')).toHaveAttribute('data-phase', 'round-reveal');
      await expect.poll(async () => page.evaluate(async () => {
        const { createPersistenceService } = await import(/* @vite-ignore */ '/src/persistence/factory.ts');
        const saved = await createPersistenceService().loadRuntime();
        return saved?.activeMatch.history.some((e: any) => e.type === 'BUST' && e.actor === 'opponent') ?? false;
      })).toBe(true);
      await page.reload();
      await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
      await page.evaluate(async () => {
        await import(/* @vite-ignore */ '/src/table-screen-module.ts');
        const { bootstrapContent } = await import(/* @vite-ignore */ '/src/content/packages/content-loader.ts');
        await bootstrapContent({ fetch: window.fetch.bind(window) });
        const { mountGameRuntime } = await import(/* @vite-ignore */ '/src/match-screen.ts');
        void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
      });
      await expect(chip).toContainText("RESET ： 0");
      await expect(page.locator('main.table-shell')).toHaveAttribute('data-phase', 'round-reveal');
      return;
    }
    await expect(chip).toContainText("RESET ： 1");
    await expect(page.locator('.opponent-hand .card')).toHaveCount(2);
    await expect(page.locator('.opponent-hand .card-back')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stand 停牌", exact: true })).toBeEnabled();
    await expect(page.locator('#ability-notices')).toContainText("RESET！");
    await page.screenshot({ path: testInfo.outputPath(`reset-used-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Re-open the saved runtime rather than asserting only the visible state.
    await expect.poll(async () => page.evaluate(async () => {
      const { createPersistenceService } = await import(/* @vite-ignore */ '/src/persistence/factory.ts');
      const saved = await createPersistenceService().loadRuntime();
      return saved?.activeMatch.history.filter((e: any) => e.type === 'HAND_REDEALT').length ?? 0;
    })).toBe(1);
    await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
    await expect(page.locator('main.table-shell')).toHaveAttribute('data-phase', 'round-reveal');
    await expect(chip).toContainText("RESET ： 0");
    await page.evaluate(async () => {
      const { createPersistenceService } = await import(/* @vite-ignore */ '/src/persistence/factory.ts');
      const saved = await createPersistenceService().loadRuntime();
      if (!saved) throw new Error('No runtime save');
      if (saved.activeMatch.history.filter((e: any) => e.type === 'HAND_REDEALT').length !== 2) throw new Error('Accumulated resets were not consumed');
    });
  });
}
