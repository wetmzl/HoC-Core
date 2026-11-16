import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, mode: "qwen" | "glm-steal" | "glm-stop" | "glm-bust" | "ai-hit-limit") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async mode => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { loadCharacter } = await load("/src/content/characters/loader.ts");
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const registry = await load("/src/core/abilities/registry.ts");
    const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const id = mode === "qwen" ? "qwen" : "glm";
    const character = await loadCharacter(id);
    let base = createMatch(`official-${mode}-ui`, { opponentId: id, skillDeckIds: [], opponentAiSkills: mode === "ai-hit-limit" ? [] : character.aiSkills, aiProfile: { P: mode === "ai-hit-limit" ? 100 : 0, A: 0, B: 0, C: 0 } });
    const playerRanks = mode === "qwen" ? ["2", "2"] : mode === "glm-steal" ? ["2", "3", "2"] : mode === "glm-bust" ? ["10", "10"] : ["10", "8"];
    const opponentRanks = mode === "qwen" ? ["2", "2"] : mode === "ai-hit-limit" ? [...Array(6).fill("10"), "4"] : ["10", "9"];
    const ranks = [...playerRanks, ...opponentRanks, ...(mode === "glm-steal" ? ["A"] : mode === "glm-bust" ? ["5"] : []), ...Array(40).fill("2")];
    const cards = ranks.map((rank, index) => createCard("spades", rank, `${mode}-${index}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, playerRanks.length) }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(playerRanks.length, playerRanks.length + opponentRanks.length) }, stood: false, busted: false, bustLimit: undefined };
    if (mode === "qwen") {
      const held = registry.instantiateAbility({ definitionId: "a-single-coin", enabled: true, parameters: {} }, "player", "held-coin", base.abilities.sequence + 1);
      base = { ...base, abilities: addAbilityInstance(base.abilities, held), playerSkills: { ...base.playerSkills, cards: [{ kind: "player-skill", owner: "player", definitionId: held.definitionId, level: held.level ?? 1, instanceId: held.instanceId }] } };
    }
    const match = { ...base, player, opponent, shoe: { cards, cursor: playerRanks.length + opponentRanks.length, shuffleIndex: 1 },
      history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }], playerSkills: { ...base.playerSkills, drawOffer: null },
      round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
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
  test(`Qwen 第二次 Hit 自动使用并正常消耗玩家持有的主动技能牌 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "qwen");
    const hit = page.getByRole("button", { name: "Hit 要牌", exact: true });
    await hit.click();
    await expect(hit).toBeEnabled();
    expect((await savedMatch(page))?.history.filter(event => event.type === "ABILITY_PLAYED")).toEqual([]);
    await hit.click();
    await expect(page.locator("#ability-notices")).toContainText("你的外卖和奶茶");
    await expect.poll(async () => (await savedMatch(page))?.history.filter(event => event.type === "ABILITY_PLAYED").length).toBe(1);
    const state = (await savedMatch(page))!;
    expect(state.history).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", owner: "player", definitionId: "a-single-coin", instanceId: "held-coin" }));
    expect(state.playerSkills.cards).toEqual([]);
    const advantage = state.abilities.statuses.find(status => status.statusDefinitionId === "player-point-advantage" && status.owner === "player")!;
    expect(advantage.sourceInstanceId).toBe("held-coin");
    expect(state.abilities.instances.filter(instance => instance.kind === "player-skill").map(instance => instance.instanceId)).toEqual(["held-coin"]);
    expect(state.abilities.statuses).toContainEqual(expect.objectContaining({ owner: "player", statusDefinitionId: "player-point-advantage", stacks: 1 }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`qwen-delivery-${width}.png`) });
  });

  test(`GLM 从任意手牌位置偷取第一张恰好达到上限的牌 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "glm-steal");
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(page.locator("#ability-notices")).toContainText("阿里云 OSS");
    await expect.poll(async () => (await savedMatch(page))?.opponent.hand.cards.at(-1)?.id).toBe("glm-steal-0");
    const state = (await savedMatch(page))!;
    expect(state.player.hand.cards.map(card => card.id)).toEqual(["glm-steal-1", "glm-steal-2", "glm-steal-5"]);
    expect(state.shoe.cursor).toBe(6);
    expect(state.history.filter(event => event.type === "OPPONENT_HIT")).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`glm-steal-${width}.png`) });
  });

  test(`GLM 在玩家停牌后确认领先并停止要牌 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "glm-stop");
    await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
    await expect(page.locator("#ability-notices")).toContainText("原来这些不是机密吗？");
    const state = (await savedMatch(page))!;
    expect(state.lastAiDecision?.action).toBe("stand");
    expect(state.shoe.cursor).toBe(4);
    expect(state.round.outcome?.winner).toBe("opponent");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`glm-information-${width}.png`) });
  });

  for (const mode of ["glm-bust", "ai-hit-limit"] as const) {
    test(`${mode === "glm-bust" ? "GLM 要牌爆牌后停牌" : "AI 超过三倍上限后停牌"} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
      await mount(page, mode);
      await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
      await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
      await expect.poll(async () => (await savedMatch(page))?.opponent.stood).toBe(true);
      const state = (await savedMatch(page))!;
      expect(state.lastAiDecision?.action).toBe("stand");
      expect(state.opponent.busted).toBe(true);
      expect(state.opponent.hand.cards).toHaveLength(mode === "glm-bust" ? 3 : 7);
      expect(state.history.filter(event => event.type === "OPPONENT_HIT")).toHaveLength(mode === "glm-bust" ? 1 : 0);
      expect(state.shoe.cursor).toBe(mode === "glm-bust" ? 5 : 9);
      expect(state.round.outcome).toMatchObject({ winner: "player", reason: "bust" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`${mode}-${width}.png`) });
    });
  }
}
