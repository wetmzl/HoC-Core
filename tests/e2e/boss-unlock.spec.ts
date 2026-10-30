import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, count: number, required = 4) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async ({ count, required }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { getEncounterFlows, installEncounterFlows } = await load("/src/content/encounter-flows/catalog.ts");
    installEncounterFlows(getEncounterFlows().map((entry: any) => ({ ...entry, unlock: { ...entry.unlock, count: required } })));
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    save.defeats = [...["chatgpt", "llama", "gemini", "deepseek"].slice(0, count), "missing-outside-character"].map(opponentId => ({ opponentId, timestamp: new Date().toISOString() }));
    await repo.saveLongTerm(save); await repo.deleteRuntime();
    (window as any).__bossUnlockRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  }, { count, required });
  await page.locator("[data-enter-duel]").click();
}

for (const width of [320, 390, 1280]) {
  test(`Boss 阵营进度、锁定尺寸与解锁角色卡 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    const entry = page.locator(".lobby-boss-entry");
    for (const count of [0, 1, 2]) {
      await mount(page, count);
      await expect(entry).toHaveCount(0);
      await expect(page.locator(".lobby-boss-entries")).toBeHidden();
    }
    await mount(page, 3);
    const compact = await entry.boundingBox();
    expect(compact!.height).toBe(52);
    await expect(entry).toBeDisabled();
    await expect(page.locator(".boss-unlock-progress")).toContainText("3/4");
    const eyes = page.locator(".lobby-boss-eyes img");
    await expect(eyes).toBeVisible();
    expect(await eyes.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const focusError = await eyes.evaluate(async element => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const { getCharacterMetadata } = await load("/src/content/characters/catalog.ts");
      const focus = getCharacterMetadata("claude").previewFocus;
      const image = element.getBoundingClientRect(), frame = element.parentElement!.getBoundingClientRect();
      return { x: image.x + image.width * focus.x - (frame.x + frame.width / 2),
        y: image.y + image.height * focus.y - (frame.y + frame.height / 2) };
    });
    expect(Math.abs(focusError.x)).toBeLessThan(1);
    expect(Math.abs(focusError.y)).toBeLessThan(1);
    await expect(entry).not.toContainText("BOSS");
    const emblem = page.locator(".boss-faction-icon img");
    await expect(emblem).toHaveAttribute("alt", "智能核心");
    expect(await emblem.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const lockedCard = await entry.boundingBox();
    const lockedEyes = await page.locator(".lobby-boss-eyes").boundingBox();
    const lockedCopy = await page.locator(".boss-entry-copy").boundingBox();
    const nextCard = page.locator(".guest-section .character-card").first();
    const nextBox = await nextCard.boundingBox();
    const portraitBox = await nextCard.locator(".character-portrait-frame").boundingBox();
    const copyBox = await nextCard.locator(".character-copy").boundingBox();
    expect(lockedCard!.x).toBeCloseTo(nextBox!.x);
    expect(lockedCard!.width).toBeCloseTo(nextBox!.width);
    expect(lockedEyes!.x).toBeCloseTo(portraitBox!.x);
    expect(lockedEyes!.width).toBeCloseTo(portraitBox!.width);
    expect(lockedCopy!.x).toBeCloseTo(copyBox!.x);
    const nameBox = await page.locator(".boss-entry-name").boundingBox();
    const progressBox = await page.locator(".boss-unlock-progress").boundingBox();
    const lockBox = await page.locator(".boss-lock-icon").boundingBox();
    expect(nameBox!.x).toBeCloseTo(copyBox!.x);
    expect(progressBox!.x).toBeGreaterThan(lockedCopy!.x + lockedCopy!.width / 2);
    expect(progressBox!.x + progressBox!.width).toBeLessThan(lockBox!.x);
    expect(progressBox!.y + progressBox!.height / 2).toBeCloseTo(nameBox!.y + nameBox!.height / 2);
    await page.screenshot({ path: info.outputPath(`boss-locked-${width}.png`) });
    await mount(page, 4);
    await expect(entry).toBeEnabled();
    const boss = page.locator(".boss-character-card");
    const ordinary = page.locator(".guest-section .character-card").first();
    const [bossBox, ordinaryBox] = await Promise.all([boss.boundingBox(), ordinary.boundingBox()]);
    expect(bossBox!.height).toBe(ordinaryBox!.height);
    expect(bossBox!.width).toBe(ordinaryBox!.width);
    await expect(boss.locator(".character-badge[data-tier='SS']")).toBeVisible();
    await expect(boss.locator(".character-badge-crown, .character-badge-rank")).toHaveCount(0);
    expect(await boss.locator(".character-badge").evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`boss-unlocked-${width}.png`) });
    await entry.click();
    await expect(page.locator("#profile h2")).toHaveText("Claude");
    await page.locator("[data-profile-start]").click();
    await expect(page.locator(".challenge-grid")).toBeVisible();
  });
}


test("locked Boss banner appears strictly above 60 percent, not at 60 percent", async ({ page }) => {
  await mount(page, 3, 5);
  await expect(page.locator(".lobby-boss-entry")).toHaveCount(0);
  await mount(page, 4, 5);
  await expect(page.locator(".lobby-boss-entry")).toBeDisabled();
  await expect(page.locator(".boss-unlock-progress")).toContainText("4/5");
});
