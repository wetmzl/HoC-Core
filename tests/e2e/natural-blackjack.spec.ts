import { expect, test, type Page } from "@playwright/test";

async function mountTable(page: Page, reducedMotion = false, ordinary21 = false) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async ({ reducedMotion, ordinary21 }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { instantiateAbility } = await load("/src/core/abilities/registry.ts");
    const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
    const base = createMatch("natural-table-feedback", { opponentId: "chatgpt", opponentAiSkills: [], skillDeckIds: [] });
    const ranks = ordinary21 ? ["7", "7", "7"] : ["K", "K"];
    const playerCards = ranks.map((rank, i) => createCard("spades", rank, `natural-player-${i}`));
    const opponentCards = [createCard("hearts", "A"), createCard("hearts", "K")];
    const used = [...playerCards, ...opponentCards];
    const cards = [...used, ...Array.from({ length: 30 }, (_, i) => createCard("clubs", "2", `natural-shoe-${i}`))];
    const player = { ...base.player, hand: { cards: playerCards }, stood: false, busted: false };
    const opponent = { ...base.opponent, hand: { cards: opponentCards }, stood: true, busted: false };
    const instance = instantiateAbility({ definitionId: "counterclockwise-clock", enabled: true, parameters: {} }, "player", "natural-test-skill", base.abilities.sequence + 1, undefined, "player-skill");
    const match = { ...base, player, opponent, abilities: addAbilityInstance(base.abilities, instance),
      shoe: { cards, cursor: used.length, shuffleIndex: 1 },
      playerSkills: { ...base.playerSkills, drawOffer: null, cards: [{ instanceId: instance.instanceId, definitionId: instance.definitionId, owner: "player", kind: "player-skill" }] },
      round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }, ...used.map((card, i) => ({ type: "CARD_DEALT", actor: i < playerCards.length ? "player" : "opponent", card, private: true }))] };
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.reducedMotion = reducedMotion; save.settings.soundEnabled = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));
    const { gameAudio } = await load("/src/audio/game-audio.ts");
    (window as any).__naturalAudio = [];
    gameAudio.play = (cue: string) => { (window as any).__naturalAudio.push(cue); };
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    (window as any).__naturalRuntime = await mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  }, { reducedMotion, ordinary21 });
  await expect(page.locator("main.table-shell")).toBeVisible();
}

const cues = (page: Page) => page.evaluate(() => (window as any).__naturalAudio);

test("真实新牌局开局获得天然21点只播放一次提示音", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { isBlackjack } = await load("/src/core/blackjack/hand.ts");
    let seedWord = 1;
    while (!isBlackjack(createMatch(seedWord.toString(16).padStart(8, "0") + "0".repeat(24), { opponentAiSkills: [] }).player.hand)) seedWord++;
    const random = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((array: any) => {
      if (array instanceof Uint32Array && array.length === 4) { array.set([seedWord, 0, 0, 0]); return array; }
      return random(array);
    }) as typeof crypto.getRandomValues;
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repository.saveLongTerm(save);
    const { gameAudio } = await load("/src/audio/game-audio.ts");
    (window as any).__naturalAudio = [];
    gameAudio.play = (cue: string) => { (window as any).__naturalAudio.push(cue); };
  });
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator('[data-enter-duel]').click();
  await page.locator('[data-invite-character]').first().click();
  await page.locator('[data-profile-start]').click();
  await expect(page.locator(".player-zone .hand-score-base")).toHaveClass(/is-blackjack/);
  expect((await cues(page)).filter((cue: string) => cue === "naturalBlackjack")).toHaveLength(1);
  await page.locator(".skill-drawer-toggle").click();
  expect((await cues(page)).filter((cue: string) => cue === "naturalBlackjack")).toHaveLength(1);
});

for (const width of [390, 320, 1280]) {
  test(`技能获得天然21点、隐藏对手与读档 ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    await mountTable(page);
    const score = page.locator(".player-zone .hand-score-base");
    await expect(score).not.toHaveClass(/is-blackjack/);
    await expect(page.locator(".opponent-hand .hand-score-base")).not.toHaveClass(/is-blackjack/);
    await page.locator(".skill-drawer-toggle").click();
    await page.locator('[data-skill-id="counterclockwise-clock"]').click();
    await expect(score).toHaveText("21");
    await expect(score).toHaveClass(/is-blackjack/);
    await expect(score).toHaveCSS("color", "rgb(246, 206, 104)");
    await expect(score).toHaveCSS("animation-name", "hand-score-golden-breathe");
    await expect(score).toHaveCSS("animation-duration", "2.8s");
    expect(await cues(page)).toEqual(["skillUse", "naturalBlackjack"]);
    await page.screenshot({ path: testInfo.outputPath(`natural-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.evaluate(async () => {
      const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
      return (await createPersistenceService().loadRuntime())?.activeMatch.player.hand.cards[1].attributes.rank;
    })).toBe("A");
    await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
      const saved = await repository.loadRuntime();
      await (window as any).__naturalRuntime.dispose(); await repository.saveRuntime(saved);
      (window as any).__naturalAudio.length = 0;
      const { mountGameRuntime } = await load("/src/match-screen.ts");
      (window as any).__naturalRuntime = await mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
    });
    await expect(score).toHaveClass(/is-blackjack/);
    expect(await cues(page)).toEqual([]);
    await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
    await expect(page.locator(".opponent-hand .hand-score-base")).toHaveClass(/is-blackjack/);
    expect(await cues(page)).toEqual(["stand"]);
  });
}

test("多张21点没有金色反馈，减少动态效果保留静态金色", async ({ page }) => {
  await mountTable(page, true, true);
  const score = page.locator(".player-zone .hand-score-base");
  await expect(score).toHaveText("21"); await expect(score).not.toHaveClass(/is-blackjack/);
  expect(await cues(page)).toEqual([]);
  await mountTable(page, true);
  await page.locator(".skill-drawer-toggle").click();
  await page.locator('[data-skill-id="counterclockwise-clock"]').click();
  await expect(score).toHaveClass(/is-blackjack/);
  await expect(score).toHaveCSS("animation-name", "none");
  await expect(score).toHaveCSS("color", "rgb(246, 206, 104)");
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  await expect(score).not.toHaveClass(/is-blackjack/);
  expect(await cues(page)).toEqual(["skillUse", "naturalBlackjack", "cardFlip"]);
});
