import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshots = resolve("output/stand-turns-review");
async function capture(page: Page, name: string) {
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, `${name}.png`) });
}
async function storedMatch(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    return (await createPersistenceService().loadRuntime())?.activeMatch;
  });
}
async function mountFixture(page: Page, restore = false, autoSkipAfterStand = false) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async ({ restore, autoSkipAfterStand }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    if (!restore) {
      const { createMatch } = await load("/src/core/match/reducer.ts");
      const { createCard } = await load("/src/core/blackjack/card.ts");
      const { instantiateAbility } = await load("/src/core/abilities/registry.ts");
      const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
      const base = createMatch("neutral-stand-ui", { opponentId: "chatgpt", skillDeckIds: [], opponentAiSkills: [], autoSkipAfterStand, aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
      const cards = ["10", "8", "2", "3", "5", "8", ...Array(24).fill("2")].map((rank, index) => createCard("spades", rank, `stand-ui-${index}`));
      const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
      const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
      const instance = instantiateAbility({ definitionId: "critical-judgment", enabled: true, parameters: {} }, "player", "example-stand-card", base.abilities.sequence + 1, undefined, "player-skill");
      const match = { ...base, player, opponent, abilities: addAbilityInstance(base.abilities, instance),
        shoe: { cards, cursor: 4, shuffleIndex: 1 },
        playerSkills: { ...base.playerSkills, deckDefinitionIds: undefined, drawOffer: null, drawCount: 1, cards: [{ instanceId: instance.instanceId, definitionId: instance.definitionId, owner: "player", kind: "player-skill" }] },
        round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null },
        history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }, ...cards.slice(0, 4).map((card, index) => ({ type: "CARD_DEALT", actor: index < 2 ? "player" : "opponent", card, private: index % 2 === 1 }))] };
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
      // A conflicting long-term preference must not override the match snapshot on restore.
      save.settings.autoSkipAfterStand = true;
      save.tutorialProgress.completedIds.push("adult-content-warning");
      await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    }
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    (window as any).__testRuntimeHandle = await mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, { restore, autoSkipAfterStand });
  await expect(page.getByRole("button", { name: "Stand 停牌", exact: true })).toBeEnabled();
}

test("设置默认开启、保存、刷新及新牌局快照", async ({ page }) => {
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const { createDefaultSave } = await import(/* @vite-ignore */ "/src/persistence/boot.ts");
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await createPersistenceService().saveLongTerm(save);
  });
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator('[data-open="settings"]').click();
  const checkbox = page.getByRole("checkbox", { name: "Stand 后自动跳过回合" });
  await expect(checkbox).toBeChecked();
  await capture(page, "settings-default-390");
  await checkbox.uncheck();
  await expect.poll(() => page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    return (await createPersistenceService().loadLongTerm())?.settings;
  })).toMatchObject({ autoSkipAfterStand: false, soundEnabled: true });
  await capture(page, "settings-off-390");
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator('[data-open="settings"]').click();
  await expect(checkbox).not.toBeChecked();
  await page.locator('#settings [data-close]').click();
  await page.locator('[data-enter-duel]').click();
  await page.locator('[data-invite-character]').first().click();
  await page.locator('[data-profile-start]').click();
  await expect(page.locator("main.table-shell")).toBeVisible();
  await expect.poll(async () => (await storedMatch(page))?.autoSkipAfterStand).toBe(false);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }]) {
  test(`停牌后技能、再次 Stand、恢复和结算 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountFixture(page);
    const hit = page.getByRole("button", { name: "Hit 要牌", exact: true });
    const stand = page.getByRole("button", { name: "Stand 停牌", exact: true });
    await stand.click();
    await expect(hit).toBeDisabled();
    await expect(stand).toBeEnabled();
    await expect(page.locator(".opponent-hand .card")).toHaveCount(3);
    await page.locator(".skill-drawer-toggle").click();
    const skill = page.locator('[data-skill-id="critical-judgment"]').first();
    await expect(skill).toBeEnabled();
    await capture(page, `stood-skills-${viewport.width}`);
    await skill.click();
    await expect(skill).toHaveAccessibleName("使用临界判断，剩余2次");
    await skill.click();
    await expect(skill).toHaveAccessibleName("使用临界判断，剩余1次");
    await expect(stand).toBeEnabled();
    await expect(hit).toBeDisabled();
    await page.getByRole("button", { name: "抽取技能，剩余 1 次", exact: true }).click();
    await page.locator(".skill-draw-card").first().click();
    await expect(stand).toBeEnabled();
    await expect.poll(async () => (await storedMatch(page))?.playerSkills.cards.length).toBe(2);
    await expect.poll(async () => (await storedMatch(page))?.round.currentActor).toBe("player");
    await mountFixture(page, true);
    await expect(hit).toBeDisabled();
    await expect(stand).toBeEnabled();
    expect((await storedMatch(page))?.autoSkipAfterStand).toBe(false);
    await capture(page, `stood-restored-${viewport.width}`);
    await stand.click();
    await expect(stand).toBeEnabled();
    await expect(page.locator(".opponent-hand .card")).toHaveCount(4);
    await stand.click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
    await expect.poll(async () => (await storedMatch(page))?.round.phase).toBe("round-reveal");
    const saved = (await storedMatch(page))!;
    expect(saved.history.filter((event: any) => event.type === "PLAYER_STOOD")).toHaveLength(1);
    expect(saved.history.filter((event: any) => event.type === "ROUND_RESOLVED")).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `settled-${viewport.width}`);
  });
}

test("默认开启时 AI 连续行动直至停牌结算", async ({ page }) => {
  await mountFixture(page, false, true);
  await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
  await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
  await expect(page.getByRole("button", { name: "Stand 停牌", exact: true })).toHaveCount(0);
});
