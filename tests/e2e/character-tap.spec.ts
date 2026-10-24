import { expect, test, type Page } from "@playwright/test";
import { mountDialogue } from "./dialogue-fixture";
const counts = (page: Page) => page.evaluate(() => { const p = (window as any).__tapProbe; return p.store.get(p.match.id, "hoc-core/character-tap", p.declaration); });
async function point(page: Page, x: number, y: number) {
  await expect.poll(() => page.locator(".character-portrait").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0 && image.clientWidth > 0 && image.clientHeight > 0)).toBe(true);
  const position = await page.locator(".character-portrait").evaluate(async (img: HTMLImageElement, p) => {
    const { imageContentBox } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
    const rect = img.getBoundingClientRect(), style = getComputedStyle(img);
    const box = imageContentBox(rect, img.naturalWidth, img.naturalHeight, style.objectFit, style.objectPosition, img.clientWidth, img.clientHeight);
    return { x: box!.left + box!.width * p.x, y: box!.top + box!.height * p.y };
  }, { x, y });
  await page.mouse.click(position.x, position.y);
}
for (const width of [1280, 390, 320]) test(`拍一拍原图坐标、区域优先和覆盖图缩放 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
  await mountDialogue(page, "tap");
  await expect(page.locator("#dialogue-text")).toHaveText("角色兜底对白");
  await point(page, .5, .25); await expect(page.locator("#dialogue-text")).toHaveText("上半区对白");
  await expect(page.locator(".character-portrait")).toHaveAttribute("alt", "拍一拍覆盖立绘");
  await point(page, .5, .75); await expect(page.locator("#dialogue-text")).toHaveText("下半区对白");
  expect(await counts(page)).toMatchObject({ roundCount: 2, consecutiveCount: 2, totalCount: 2 });
  await page.locator(".character-portrait").focus(); await page.keyboard.press("Enter"); await expect(page.locator("#dialogue-text")).toHaveText("键盘对白");
  await page.keyboard.press("Space"); expect(await counts(page)).toMatchObject({ totalCount: 4 });
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白"); expect(await counts(page)).toMatchObject({ consecutiveCount: 0, totalCount: 4 });
  await page.clock.runFor(1000);
  // AI pose is independently identified and stays interactive during its wait.
  await point(page, .5, .25); await expect(page.locator("#dialogue-text")).toHaveText("上半区对白");
  expect(await counts(page)).toMatchObject({ consecutiveCount: 1, totalCount: 5 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("拍一拍刷新保留计数、正常对白恢复且停用清除来源", async ({ page }) => {
  await mountDialogue(page, "tap"); await point(page, .5, .25); await point(page, .5, .25);
  await page.evaluate(async () => { await (window as any).__tapProbe.store.flush(); });
  await page.reload(); await mountDialogue(page, "tap", true);
  await expect(page.locator("#dialogue-text")).toHaveText("角色兜底对白");
  expect(await counts(page)).toMatchObject({ roundCount: 2, consecutiveCount: 0, totalCount: 2 });
  await page.locator(".character-portrait").focus(); await page.keyboard.press("Enter");
  expect(await counts(page)).toMatchObject({ totalCount: 3, consecutiveCount: 1 });
  await page.evaluate(() => (window as any).__tapProbe.plugins.release());
  await page.keyboard.press("Enter"); expect(await counts(page)).toMatchObject({ totalCount: 3 });
});

test("未标定图片点击触发全立绘，键盘不虚构区域", async ({ page }) => {
  await mountDialogue(page, "tap-default");
  await point(page, .5, .5);
  await expect(page.locator("#dialogue-text")).toHaveText("整图区域对白");
  await point(page, .5, .25);
  expect(await counts(page)).toMatchObject({ totalCount: 2 });
  await page.locator(".character-portrait").focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#dialogue-text")).toHaveText("键盘对白");
});

for (const phase of ["round-reveal", "roulette-reaction", "roulette-trigger", "roulette-result"]) test(`牌桌 ${phase} 阶段仍将点击交给角色规则`, async ({ page }, testInfo) => {
  await mountDialogue(page, "tap-default", false, phase, phase === "roulette-result");
  await point(page, .5, .25);
  await expect(page.locator("#dialogue-text")).toHaveText("整图区域对白");
  await page.locator(".character-portrait").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dialogue-text")).toHaveText("键盘对白");
  expect(await counts(page)).toMatchObject({ totalCount: 2 });
  await page.screenshot({ path: testInfo.outputPath(`tap-${phase}.png`), fullPage: true });
});
