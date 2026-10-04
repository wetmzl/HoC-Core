import { expect, test, type Page } from "@playwright/test";

const longLine = "这是一段用于检查滚动阅读的示例台词。".repeat(35);
const viewports = [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 1280, height: 900 }];

async function mountTable(page: Page, options: { text: string; reducedMotion?: boolean; phase?: string; advice?: boolean; displays?: number; debug?: boolean }) {
  await page.goto(options.debug ? "/?debug" : "/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  if (options.reducedMotion === false) await page.clock.install();
  await page.evaluate(async (options) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
    await bootstrapContent({ fetch: window.fetch.bind(window) });
    const { installCharacterCatalog } = await load("/src/content/characters/catalog.ts");
    const { installCharacterDefinitions, loadCharacter } = await load("/src/content/characters/loader.ts");
    const { DIALOGUE_EVENT_CODES } = await load("/src/dialogue/types.ts");
    // Reuse public neutral artwork; all test identity, abilities and copy are generic.
    const baseCharacter = await loadCharacter("chatgpt");
    const character = { ...baseCharacter, id: "example-table", name: "示例对手", tags: [], unlock: undefined, aiSkills: [],
      dialogue: Object.fromEntries(DIALOGUE_EVENT_CODES.map((event: string) => [event, [options.text]])) };
    installCharacterCatalog([{ id: character.id, name: character.name, subtitle: "布局验证", tier: "D", tags: [],
      previewImage: "/assets/package-cover-fallback.png", portraitScales: character.portraitScales }], character.id);
    installCharacterDefinitions([character]);
    const registry = await load("/src/core/abilities/registry.ts");
    const ai = { id: "example-table-display", name: "示例读数", description: "中性布局夹具", sourceKind: "ai-skill", primaryDomain: "gambler",
      tags: ["display"], activation: { type: "automatic" }, rules: [], displays: Array.from({ length: options.displays ?? 0 }, (_, i) => ({
        id: `value-${i}`, target: "owner", description: "示例状态说明", content: [{ type: "text", text: "示例：" }, { type: "number", value: i }]
      })) };
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, ai], registry.STATUS_DEFINITIONS, registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    const base = createMatch("neutral-table-layout", { opponentId: character.id,
      opponentAiSkills: [{ definitionId: ai.id, enabled: true, parameters: {} }] });
    const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", "2", `table-${i}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, bustLimit: undefined };
    const phase = options.phase ?? "turns";
    const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
      playerSkills: { ...base.playerSkills, drawCount: 2, drawOffer: null, advice: options.advice ? "hit" : null },
      round: { ...base.round, player, opponent, phase, currentActor: phase === "turns" ? "player" : null,
        outcome: phase === "turns" ? null : { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    save.settings.reducedMotion = options.reducedMotion ?? true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repo = createPersistenceService();
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, options);
  await expect(page.locator(".table-bottom")).toBeVisible();
}

async function assertLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const bottom = rect(".table-bottom"), top = rect(".table-top"), bubble = rect(".dialogue"), dock = rect(".action-dock");
    const rows = [".opponent-hand", ".table-notice-row", ".player-zone .hand-row", ".action-dock"].map(rect);
    return { fits: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
      visible: bottom.top >= top.bottom && dock.bottom <= innerHeight,
      dialogueFits: bubble.bottom <= bottom.top && bubble.top >= top.bottom,
      ordered: rows.every((row, i) => i === 0 || rows[i - 1].bottom <= row.top),
      bottomTop: bottom.top };
  });
  expect(layout.fits).toBe(true);
  expect(layout.visible).toBe(true);
  expect(layout.dialogueFits).toBe(true);
  expect(layout.ordered).toBe(true);
  return layout.bottomTop;
}

for (const viewport of viewports) {
  test(`底部操作区与台词内部滚动 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: "示例短台词。", displays: 14 });
    const bottomTop = await assertLayout(page);
    const scroll = page.locator(".dialogue-scroll");
    expect(await scroll.evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
    await page.locator("#dialogue-text").evaluate((e, text) => { e.textContent = text; }, longLine + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(30));
    await expect.poll(() => scroll.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await scroll.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(viewport.height <= 760 ? 136 : 160);
    if (viewport.width > 320) expect(await scroll.evaluate((e) => e.clientHeight)).toBe(160);
    expect(await assertLayout(page)).toBe(bottomTop);
    await page.locator("[data-display-toggle]").click();
    expect(await assertLayout(page)).toBe(bottomTop);
    await scroll.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    expect(await scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    const box = (await scroll.boundingBox())!;
    expect(await scroll.evaluate((e) => {
      const box = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(box.left + 2, box.top + box.height / 2));
    })).toBe(true);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await scroll.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(0);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`table-long-${viewport.width}.png`) });
  });

  test(`打字跟随、暂停、恢复与重绘 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: longLine, reducedMotion: false });
    const scroll = page.locator(".dialogue-scroll");
    const text = page.locator("#dialogue-text");
    await page.clock.runFor(4800);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    expect(await scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(4);
    await scroll.evaluate((e) => { e.scrollTop = 20; e.dispatchEvent(new Event("scroll")); });
    const lengthBefore = await text.evaluate((e) => e.textContent!.length);
    await page.clock.runFor(480);
    expect(await text.evaluate((e) => e.textContent!.length)).toBeGreaterThan(lengthBefore);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    await page.locator(".draw-skill-button").click();
    await expect(page.locator(".skill-draw-modal")).toBeVisible();
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    expect(await text.evaluate((e) => e.textContent!.length)).toBeLessThan(longLine.length);
    await page.locator(".skill-draw-card").first().click();
    await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    await scroll.evaluate((e) => { e.scrollTop = e.scrollHeight - e.clientHeight - 3; e.dispatchEvent(new Event("scroll")); });
    await page.clock.runFor(960);
    expect(await scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    expect(await text.evaluate((e) => e.textContent!.length)).toBeLessThan(10);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
    await assertLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`table-typing-${viewport.width}.png`) });
  });
}

for (const phase of ["turns", "round-reveal", "roulette-trigger", "roulette-result", "round-end"]) {
  test(`窄屏回合按钮与技能建议 ${phase}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mountTable(page, { text: longLine, phase, advice: true, displays: phase === "roulette-result" ? 0 : 3 });
    await assertLayout(page);
    await expect(page.locator(".skill-advice")).toBeVisible();
    await expect(page.locator(".action-dock button").first()).toBeVisible();
    await expect(page.locator("#dialogue-text")).toHaveText(longLine);
    if (phase === "roulette-result") {
      const addedLines = await page.locator(".dialogue-scroll").evaluate((e) => (e.clientHeight - 96) / parseFloat(getComputedStyle(e).lineHeight));
      expect(addedLines).toBeGreaterThanOrEqual(1.9);
      expect(addedLines).toBeLessThanOrEqual(2.1);
    }
    if (phase === "turns") {
      const scroll = page.locator(".dialogue-scroll");
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
      // A completed, motion-free line must retain the opening on a redraw too.
      await page.locator(".draw-skill-button").click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
      await page.locator(".skill-draw-card").first().click();
      await scroll.evaluate((e) => { e.scrollTop = 20; e.dispatchEvent(new Event("scroll")); });
      await page.locator(".draw-skill-button").click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
      await page.locator(".skill-draw-card").first().click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    }
    await page.screenshot({ path: testInfo.outputPath(`table-phase-${phase}.png`) });
  });
}


test("调试面板保持可访问且不挤占牌桌", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mountTable(page, { text: "示例台词。", debug: true });
  expect(await page.locator(".action-dock").evaluate((e) => e.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await page.locator("[data-copy-debug]").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-copy-debug]")).toBeVisible();
  await expect(page.locator(".dev-hud")).toContainText("开发者面板");
});
