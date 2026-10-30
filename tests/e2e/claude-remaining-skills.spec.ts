import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, mode: "transfer" | "protection") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async mode => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const skill = mode === "transfer" ? "claude-ss-reasoning" : "claude-ss-verdict";
    const base = createMatch("claude-remaining-ui", { opponentId: "claude", skillDeckIds: [], opponentAiSkills: [{ definitionId: skill, enabled: true, level: 2, parameters: {} }], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    const cards = ["3", "4", "5", "6", ...Array(40).fill("2")].map((rank, index) => createCard("spades", rank, `remaining-${index}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
      roulette: { player: { capacity: 8, bullets: 0 }, opponent: { capacity: 8, bullets: 4 } },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }], playerSkills: { ...base.playerSkills, drawOffer: null },
      round: { ...base.round, player, opponent, phase: mode === "transfer" ? "turns" : "round-reveal", currentActor: mode === "transfer" ? "player" : null,
        outcome: mode === "transfer" ? null : { reason: "comparison", winner: "player", penaltyTarget: "opponent", bulletsAdded: 1 } } };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  }, mode);
  await expect(page.locator("main.table-shell")).toBeVisible();
}
async function savedMatch(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    return (await createPersistenceService().loadRuntime())?.activeMatch;
  });
}

for (const width of [390, 320]) {
  test(`禁止蒸馏实际 Hit 交接与通知 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "transfer");
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(page.locator("#ability-notices")).toContainText("禁止蒸馏");
    await expect(page.locator("#ability-notices")).toContainText("代替本次 Hit");
    await expect(page.locator("#ability-notices")).not.toContainText("免于扣扳机");
    await expect.poll(async () => (await savedMatch(page))?.opponent.hand.cards.at(-1)?.id).toBe("remaining-4");
    const state = (await savedMatch(page))!;
    expect(state.player.hand.cards).toHaveLength(2);
    expect(state.shoe.cursor).toBe(5);
    expect(state.history.filter(e => e.type === "OPPONENT_HIT")).toHaveLength(0);
    expect(state.round.currentActor).toBe("player");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`distillation-${width}.png`) });
  });

  test(`高岭之花跳过四发扳机阶段 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "protection");
    await page.locator("button[data-action*='ACK_ROUND_RESULT']").click();
    await expect.poll(async () => (await savedMatch(page))?.roundIndex).toBe(1);
    const state = (await savedMatch(page))!;
    expect(state.history.some(e => e.type === "TRIGGER_PULLED")).toBe(false);
    expect(state.roulette.opponent.bullets).toBe(4);
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "turns");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`flower-${width}.png`) });
  });
}
