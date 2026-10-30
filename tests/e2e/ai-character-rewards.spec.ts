import { expectSkillSheet } from "./skill-sheet-assertions";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshots = resolve("output/ai-character-rewards");
async function runtime(page: Page) {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await (await load("/src/persistence/factory.ts")).createPersistenceService().loadRuntime())?.activeMatch;
  });
}
async function mountFixture(page: Page, missingSuit = false) {
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async (missingSuit) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { INITIAL_PLAYER_SKILL_IDS } = await load("/src/core/skills/definitions.ts");
    const rewards = ["chatgpt-reset-player", "claude-account-ban", "gemini-vast-world", "deepseek-stealing-food-player"];
    const base = createMatch("reward-preview", { opponentId: "llama", skillDeckIds: [], unlockedPlayerSkillIds: [...INITIAL_PLAYER_SKILL_IDS, ...rewards] });
    const cards = [createCard("spades", "8", "p-public"), createCard("hearts", "9", "p-private"), createCard("clubs", "8", "o-public"), createCard(missingSuit ? "clubs" : "diamonds", "9", "o-private"), createCard("spades", "2", "reset-public"), createCard("spades", "3", "reset-private"), ...Array.from({ length: 40 }, (_, i) => createCard("spades", "2", `remaining-${i}`))];
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, bustLimit: undefined };
    let match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
    for (const id of rewards) match = gameReducer({ ...match, playerSkills: { ...match.playerSkills, drawCount: 1, drawOffer: { id: `preview-${id}`, refreshesRemaining: 0, candidateDefinitionIds: [id] } } }, { type: "SELECT_SKILL_DRAW", definitionId: id });
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    save.defeats = ["chatgpt", "claude", "gemini", "deepseek"].map(opponentId => ({ opponentId, timestamp: "2026-10-15T00:00:00.000Z" }));
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, missingSuit);
  const warning = page.locator("#adult-content-warning");
  if (await warning.isVisible()) await warning.getByRole("button", { name: "我已成年并继续" }).click();
  await page.locator(".skill-drawer-toggle").click();
  await expect(page.locator('[data-skill-id="chatgpt-reset-player"]')).toBeVisible();
}

for (const [width, height] of [[1280, 900], [390, 844], [320, 720]]) {
  test(`四项击败奖励的使用、提示与持久化 ${width}`, async ({ page }) => {
    mkdirSync(screenshots, { recursive: true });
    await page.setViewportSize({ width, height });
    await mountFixture(page);
    const shot = async (name: string) => page.screenshot({ path: resolve(screenshots, `${name}-${width}.png`), animations: "disabled" });
    await shot("01-ready");
    await page.locator('[data-skill-info="chatgpt-reset-player"]').click();
    await expect(page.locator("#skill-info-dialog")).toContainText("每张一次");
    await expectSkillSheet(page.locator("#skill-info-dialog .skill-sheet"));
    await page.locator("#skill-info-dialog .skill-sheet summary").click();
    await shot("02-reset-info");
    await page.locator("[data-skill-close]").click();
    await page.locator('[data-skill-id="gemini-vast-world"]').click();
    await expect(page.locator("#ability-notices")).toContainText("玩家本回合点数优势 +2");
    await shot("03-world-plus-two");
    await page.locator('[data-skill-id="deepseek-stealing-food-player"]').click();
    await expect(page.locator("#ability-notices")).toContainText("对手本回合点数优势 −1");
    await shot("04-snack-minus-one");
    await page.locator('[data-skill-id="chatgpt-reset-player"]').click();
    await expect.poll(async () => (await runtime(page))?.player.hand.cards.map((c: any) => c.id)).toEqual(["reset-public", "reset-private"]);
    await expect(page.locator('[data-skill-id="chatgpt-reset-player"]')).toHaveCount(0);
    await shot("05-reset-used");
    await page.locator('[data-skill-id="claude-account-ban"]').click();
    await expect.poll(async () => (await runtime(page))?.opponent.stood).toBe(true);
    await expect(page.getByRole("button", { name: "Hit 要牌", exact: true })).toBeEnabled();
    await expect(page.locator("#ability-notices")).toContainText("封禁账号");
    await shot("06-opponent-forced-stand");
    expect((await runtime(page))?.playerSkills.cards).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Reload the actual stored match through the ordinary launcher.
    await page.reload();
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    await expect(page.locator("main.table-shell")).toBeVisible();
    expect((await runtime(page))?.opponent.stood).toBe(true);
    await shot("07-restored");
  });
}

test("缺少花色时不可发动大千世界，说明仍可查看", async ({ page }) => {
  await mountFixture(page, true);
  await expect(page.locator('[data-skill-id="gemini-vast-world"]')).toBeDisabled();
  await page.locator('[data-skill-info="gemini-vast-world"]').click();
  await expect(page.locator("#skill-info-dialog")).toContainText("凑齐四种花色");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, "08-missing-suit-390.png"), animations: "disabled" });
});

for (const defeated of [false, true]) {
  test(`既有长期档的奖励技能与卡组备选区 ${defeated ? "已击败" : "未击败"}`, async ({ page }) => {
    await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.evaluate(async defeated => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      await load("/src/table-screen-module.ts");
      await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
      const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
      const { INITIAL_PLAYER_SKILL_IDS } = await load("/src/core/skills/definitions.ts");
      save.skipTutorial = true; save.settings.soundEnabled = false;
      save.profile.skillDeck = { carried: [...INITIAL_PLAYER_SKILL_IDS], reserve: [] };
      if (defeated) save.defeats = ["chatgpt", "claude", "gemini", "deepseek"].map(opponentId => ({ opponentId, timestamp: "2026-10-15T00:00:00.000Z" }));
      await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
      void (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
    }, defeated);
    await expect(page.locator("#adult-content-warning")).toBeVisible();
    await page.getByRole("button", { name: "我已成年并继续" }).click();
    await page.locator("[data-open=skills]").click();
    for (const id of ["chatgpt-reset-player", "claude-account-ban", "gemini-vast-world", "deepseek-stealing-food-player"]) {
      await expect(page.locator(`[data-deck-grid=reserve] [data-deck-id="${id}"]`)).toHaveCount(defeated ? 1 : 0);
    }
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, `${defeated ? "10-unlocked" : "09-locked"}-390.png`), animations: "disabled" });
    if (defeated) {
      await page.locator('[data-deck-id="claude-account-ban"]').click();
      await expect(page.locator(".deck-detail")).toContainText("立即强制对手 Stand");
      await page.screenshot({ path: resolve(screenshots, "11-unlocked-detail-390.png"), animations: "disabled" });
    }
  });
}
