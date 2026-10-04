import { expect, test } from "@playwright/test";

async function mountFixture(page: import("@playwright/test").Page, blockStand = false): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async (blockStand) => {
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
    const character = await loadCharacter("claude");
    const base = createMatch("claude-ui", { opponentId: "claude", opponentAiSkills: blockStand ? [] : character.aiSkills, aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    const ranks = ["10", "10", "10", "10", "2", "2", ...Array(40).fill("2")];
    const cards = ranks.map((rank, index) => createCard("spades", rank, `claude-ui-${index}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    let match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, phase: "turns", currentActor: blockStand ? "player" : "opponent", outcome: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
    if (blockStand) {
      const { ABILITY_REGISTRY, installAbilityRegistry, instantiateAbility } = await load("/src/core/abilities/registry.ts");
      const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
      const definition = { id: "example-no-stand", name: "示例封锁", description: "示例", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" }, rules: [] };
      installAbilityRegistry([...ABILITY_REGISTRY.definitions, definition], [...ABILITY_REGISTRY.statuses, { id: "example-block-stand", defaultDuration: "round", blocksActions: ["stand"], rules: [] }], ABILITY_REGISTRY.catalogVersion);
      const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", "example-source", 1, undefined, "ai-skill");
      const runtime = addAbilityInstance(match.abilities, instance);
      match = { ...match, abilities: { ...runtime, statuses: [{ statusDefinitionId: "example-block-stand", owner: "player", sourceInstanceId: instance.instanceId, stacks: 1, duration: "round", parameters: {}, createdAtSequence: 1 }] } };
    } else match = gameReducer(match, { type: "OPPONENT_HIT" });
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    const repo = createPersistenceService();
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, blockStand);
  const warning = page.locator("#adult-content-warning");
  if (await warning.isVisible()) await warning.getByRole("button", { name: "我已成年并继续" }).click();
  await expect(page.locator("main.table-shell")).toBeVisible();
}

for (const width of [390, 320]) {
  test(`Claude 公共上限、Hit 封锁、存档恢复及轮次重置 ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mountFixture(page);
    await expect(page.locator(".bust-limit-indicator strong")).toHaveText("22");
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    const hit = page.getByRole("button", { name: "Hit 要牌", exact: true });
    const stand = page.getByRole("button", { name: "Stand 停牌", exact: true });
    await expect(page.locator("#ability-notices")).toContainText("安全宪法");
    await expect(hit).toBeDisabled();
    await expect(stand).toBeEnabled();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "turns");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`claude-blocked-${width}.png`) });
    await expect.poll(async () => page.evaluate(async () => {
      const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
      const saved = await createPersistenceService().loadRuntime();
      return saved?.activeMatch.abilities.statuses.some((status: any) => status.statusDefinitionId === "claude-safety-no-hit") ?? false;
    })).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      await import(/* @vite-ignore */ "/src/table-screen-module.ts");
      const { bootstrapContent } = await import(/* @vite-ignore */ "/src/content/packages/content-loader.ts");
      await bootstrapContent({ fetch: window.fetch.bind(window) });
      const { mountGameRuntime } = await import(/* @vite-ignore */ "/src/match-screen.ts");
      void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
    });
    await expect(page.locator(".bust-limit-indicator strong")).toHaveText("22");
    await expect(hit).toBeDisabled();
    await expect(stand).toBeEnabled();
    await stand.click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
    await page.locator("button[data-action*='ACK_ROUND_RESULT']").click();
    await expect(page.locator(".bust-limit-indicator strong")).toHaveText("21");
    await expect(hit).toBeEnabled();
  });
  test(`通用 Stand 封锁同步禁用按钮 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mountFixture(page, true);
    await expect(page.getByRole("button", { name: "Stand 停牌", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Hit 要牌", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
