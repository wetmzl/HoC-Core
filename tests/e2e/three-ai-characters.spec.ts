import { skipStory } from "./story-platform-fixture";
import { expect, test } from "@playwright/test";

for (const [width, height] of [[390, 844], [320, 720]]) for (const id of ["glm", "grok", "qwen", "deepseek"]) {
  test(`${id} installs, opens its profile and starts with readable table art at ${width}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addLocatorHandler(page.locator("[data-acknowledge-adult-content]:enabled"), async button => { await button.click(); }, { noWaitAfter: true });
    await page.addLocatorHandler(page.locator("[data-tutorial-skip]:enabled"), async button => { await button.click(); }, { noWaitAfter: true });
    await page.goto("/");
    await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 60_000 });
    await page.evaluate(async id => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
      const prerequisites = id === "deepseek" ? ["llama"] : ["llama", "deepseek", "chatgpt"];
      save.defeats = prerequisites.map(opponentId => ({ opponentId, timestamp: new Date().toISOString() }));
      await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
    }, id);
    await page.locator("[data-start-game]").click();
    await page.locator("[data-enter-duel]").click();
    await expect(page.locator("[data-story-player]")).toBeVisible();
    await skipStory(page);
    await expect(page.locator("[data-story-player]")).toHaveCount(0);
    const invite = page.locator(`[data-invite-character="${id}"]`);
    for (let n = 0; n < 30 && !await invite.count(); n++) await page.locator("[data-refresh-guests]").click();
    await expect(invite).toBeVisible();
    await invite.click();
    await expect(page.locator("#profile")).toBeVisible();
    const cover = page.locator("#profile .profile-portrait");
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([1254, 1254]);
    await expect(page.locator("#profile .skill-sheet")).toHaveCount(id === "glm" || id === "grok" ? 2 : 1);
    await page.screenshot({ path: testInfo.outputPath(`${id}-profile-${width}.png`) });
    await page.locator("#profile [data-profile-start]").click();
    await expect(page.locator("main.table-shell")).toBeVisible();
    const portrait = page.locator(".character-portrait");
    await expect.poll(() => portrait.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator("main.table-shell")).not.toHaveAttribute("data-phase", /^(dealing|initial-blackjack-check)$/);
    await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
    await expect(page.locator("#dialogue-text")).not.toHaveText("");
    await page.screenshot({ path: testInfo.outputPath(`${id}-table-${width}.png`) });
    // full-portrait 对白要求真实图片坐标；键盘事件按契约传 null。
    const point = await portrait.evaluate(async (image: HTMLImageElement) => {
      const { imageContentBox } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
      const style = getComputedStyle(image);
      const box = imageContentBox(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, style.objectFit, style.objectPosition, image.clientWidth, image.clientHeight)!;
      return { x: box.left + box.width * .5, y: box.top + box.height * .4 };
    });
    const phase = await page.locator("main.table-shell").getAttribute("data-phase");
    await page.mouse.click(point.x, point.y);
    const roulette = phase === "roulette-reaction" || phase === "roulette-trigger";
    await expect.poll(() => portrait.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual(roulette ? [1152, 768] : [1536, 1024]);
    await page.screenshot({ path: testInfo.outputPath(`${id}-tap-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
