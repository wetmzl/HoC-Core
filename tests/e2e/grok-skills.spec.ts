import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, mode: "zero" | "gift" | "reward") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async mode => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { loadCharacter } = await load("/src/content/characters/loader.ts");
    const { createMatch, normalizeAbilityHands } = await load("/src/core/match/reducer.ts");
    const { createCard, createDerivedCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const registry = await load("/src/core/abilities/registry.ts");
    const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const character = await loadCharacter("grok");
    const extra = mode === "gift" ? [{ id: "neutral-browser-grok-source", name: "Derived source", description: "Neutral acquisition fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "acquire", trigger: "before-card-draw", conditions: [{ type: "actor-is", actor: "owner" }], effects: ["A", "K"].map(rank => ({ type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank }, suit: { type: "static", suit: "clubs" } }] })) }] }] : [];
    if (extra.length) registry.installAbilityRegistry([...registry.ABILITY_REGISTRY.definitions, ...extra], registry.ABILITY_REGISTRY.statuses, registry.ABILITY_REGISTRY.catalogVersion);
    let base = createMatch(`grok-${mode}-ui`, { opponentId: mode === "reward" ? "llama" : "grok", skillDeckIds: [], grantOpeningSkills: false, openingSkillCards: 0,
      opponentAiSkills: mode === "reward" ? [] : [...character.aiSkills, ...extra.map(entry => ({ definitionId: entry.id, enabled: true, parameters: {} }))], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    const playerRanks = mode === "zero" ? ["10", "10"] : ["10", "8"];
    const ranks = [...playerRanks, "2", "3", ...Array(40).fill("2")];
    const cards = ranks.map((rank, index) => createCard("spades", rank, `${mode}-physical-${index}`));
    const player = { ...base.player, hand: { cards: [...cards.slice(0, 2), ...(mode === "reward" ? [createDerivedCard("hearts", "K", "reward-held-derived")] : [])] }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    for (const definitionId of mode === "gift" ? [] : mode === "reward" ? ["grok-player", "compound-interest"] : ["compound-interest"]) {
      const instanceId = `held-${definitionId}`;
      const held = registry.instantiateAbility({ definitionId, enabled: true, parameters: {} }, "player", instanceId, base.abilities.sequence + 1);
      base = { ...base, abilities: addAbilityInstance(base.abilities, held), playerSkills: { ...base.playerSkills, unlockedDefinitionIds: [...new Set([...base.playerSkills.unlockedDefinitionIds, definitionId])], cards: [...base.playerSkills.cards, { kind: "player-skill", owner: "player", definitionId, level: held.level ?? 1, instanceId }] } };
    }
    const match = normalizeAbilityHands({ ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }], playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } });
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
async function playHeld(page: Page, id: string) {
  const drawer = page.locator(".skill-drawer-toggle");
  if (await drawer.getAttribute("aria-expanded") !== "true") await drawer.click();
  await page.locator(`[data-skill-instance="held-${id}"] button[data-skill-id="${id}"]`).click();
}

for (const width of [390, 320]) {
  test(`Grok 将玩家新获衍生牌计为0且保留牌面 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "zero");
    await playHeld(page, "compound-interest");
    const excluded = page.getByRole("region", { name: "玩家手牌，可横向滑动", exact: true }).locator(".card-marker-point-total-exclusion");
    await expect(excluded).toHaveCount(1);
    await expect(excluded).toHaveAttribute("aria-label", "视为0点");
    await expect.poll(async () => (await savedMatch(page))?.player.hand.cards.length).toBe(3);
    const state = (await savedMatch(page))!;
    expect(state.player.hand.cards.at(-1)?.attributes).toMatchObject({ source: "derived", rank: "2" });
    expect(state.player.busted).toBe(false);
    expect(state.playerSkills.cards).toEqual([]);
    expect(state.history.some(event => event.type === "PLAYER_HIT" || event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`grok-zero-${width}.png`) });
  });

  test(`Grok 把每张新获衍生牌原样塞给玩家且不增加Hit ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "gift");
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect.poll(async () => (await savedMatch(page))?.player.hand.cards.filter(card => card.attributes.source === "derived").length).toBe(2);
    await expect(page.locator("#ability-notices")).toContainText("想去哪里就去哪里");
    await expect(page.getByRole("region", { name: "玩家手牌，可横向滑动", exact: true }).locator(".card-marker-point-total-exclusion")).toHaveCount(2);
    const state = (await savedMatch(page))!;
    expect(state.player.hand.cards.filter(card => card.attributes.source === "derived").map(card => card.attributes.rank)).toEqual(["A", "K"]);
    expect(state.opponent.hand.cards.every(card => card.attributes.source === "shoe")).toBe(true);
    expect(state.history.filter(event => event.type === "PLAYER_HIT")).toHaveLength(1);
    expect(state.history.filter(event => event.type === "OPPONENT_HIT")).toHaveLength(1);
    expect(state.shoe.cursor).toBe(6);
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`grok-gift-${width}.png`) });
  });

  test(`主动@grok消耗原技能牌并只影响现有衍生牌 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page, "reward");
    await playHeld(page, "grok-player");
    await expect(page.locator("#ability-notices")).toContainText("@grok");
    await expect(page.locator('[data-skill-instance="held-grok-player"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "玩家手牌，可横向滑动", exact: true }).locator(".card-marker-point-total-exclusion")).toHaveCount(1);
    await expect.poll(async () => (await savedMatch(page))?.player.busted).toBe(false);
    await playHeld(page, "compound-interest");
    await expect.poll(async () => (await savedMatch(page))?.player.hand.cards.length).toBe(4);
    await expect(page.getByRole("region", { name: "玩家手牌，可横向滑动", exact: true }).locator(".card-marker-point-total-exclusion")).toHaveCount(1);
    const state = (await savedMatch(page))!;
    expect(state.player.hand.cards.find(card => card.id === "reward-held-derived")?.attributes).toMatchObject({ source: "derived", rank: "K" });
    expect(state.player.hand.cards.at(-1)?.attributes).toMatchObject({ source: "derived", rank: "3" });
    expect(state.playerSkills.cards).toEqual([]);
    expect(state.history.some(event => event.type === "PLAYER_HIT" || event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`grok-reward-${width}.png`) });
  });

  test(`已有击败记录在技能管理中显示三项新角色奖励 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      const { createDefaultSave } = await import(/* @vite-ignore */ "/tests/e2e/runtime-fixture.ts");
      const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.reducedMotion = true; save.settings.soundEnabled = false;
      save.tutorialProgress.completedIds.push("adult-content-warning");
      save.defeats = ["qwen", "glm", "grok"].map(opponentId => ({ opponentId, timestamp: "2026-11-13T00:00:00.000Z" }));
      await createPersistenceService().saveLongTerm(save);
    });
    await page.reload();
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    await page.getByRole("button", { name: "技能与天赋", exact: true }).click();
    const skills = page.locator("#skills");
    for (const [id, name, category] of [["qwen-takeaway-player", "外卖和奶茶", "主动"], ["glm-aliyun-oss-player", "阿里云OSS", "被动"], ["grok-player", "@grok", "主动"]]) {
      const card = skills.locator(`[data-deck-id="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toContainText(name);
      await expect(card).toContainText(category);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`three-ai-rewards-${width}.png`) });
  });
}
