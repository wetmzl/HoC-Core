import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("output/factions");
async function directory(page: Page, hasBadge: boolean) {
  await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  while (await page.locator("[data-load-more-defeated]").count()) {
    await page.locator("[data-load-more-defeated]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  }
  await expect(page.locator(".character-card")).toHaveCount(5);
  await expect(page.locator(".character-badge")).toHaveCount(hasBadge ? 5 : 0);
  if (hasBadge) {
    const badge = page.locator('[data-character-id="chatgpt"] .character-badge');
    await badge.click();
    await expect(page.locator('[data-character-id="chatgpt"] .character-badge-hint')).toHaveText("智能核心");
    await expect.poll(() => badge.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
}
async function manager(page: Page) { await page.getByRole("button", { name: "资源管理", exact: true }).click(); }
const card = (page: Page) => page.locator('.package-card[data-package-id="hoc-core/official-factions"]');

test("standalone faction package can be disabled, deleted and restored without blocking matches or saved-game resume", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => {
    await dialog.getByRole("button", { name: "我已成年并继续" }).click();
  });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false;
    save.defeats = ["chatgpt", "claude", "gemini", "deepseek", "llama"].map(opponentId => ({ opponentId, timestamp: "2026-10-24T00:00:00.000Z" }));
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
  mkdirSync(output, { recursive: true });
  await manager(page);
  await expect(card(page)).toContainText("阵营 ×1");
  await card(page).screenshot({ path: resolve(output, "core-package.png") });
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await directory(page, true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    await page.locator('[data-character-id="chatgpt"]').screenshot({ path: resolve(output, `core-present-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  // The optional art may fail after URL resolution; the broken emblem must disappear.
  const badge = page.locator('[data-character-id="chatgpt"] .character-badge');
  await badge.locator("img").evaluate(img => { img.setAttribute("src", "data:image/png;base64,invalid"); });
  await expect(badge).toBeHidden();
  await page.locator('[data-invite-character="chatgpt"]').click();
  await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await manager(page);
  await card(page).locator('[data-package-action="disable"]').click();
  await expect(card(page)).toHaveAttribute("data-package-state", "disabled");
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await page.locator("[data-start-game]").click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await page.screenshot({ path: resolve(output, "core-resume-without-faction.png") });
  // Preserve the long-term progress while clearing only the test match for directory checks.
  await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    await (await load("/src/persistence/factory.ts")).createPersistenceService().deleteRuntime();
  });
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await manager(page);
  await card(page).locator('[data-package-action="remove"]').click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "删除", exact: true }).click();
  await expect(card(page)).toHaveAttribute("data-package-state", "not-installed");
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await directory(page, false);
  await page.locator('[data-character-id="chatgpt"]').screenshot({ path: resolve(output, "core-missing.png") });
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await manager(page);
  await card(page).locator('[data-package-action="restore"]').click();
  await expect(card(page)).toHaveAttribute("data-package-state", "enabled");
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await directory(page, true);
  expect(errors).toEqual([]);
});
