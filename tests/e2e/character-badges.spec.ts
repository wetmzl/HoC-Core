import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test("directory badges load with packages, stay in portrait corners and honor motion settings", async ({ page }) => {
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => {
    await dialog.getByRole("button", { name: "我已成年并继续" }).click();
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false;
    save.defeats = ["llama", "deepseek", "gemini", "claude", "chatgpt"].map(opponentId => ({ opponentId, timestamp: "2026-10-23T00:00:00.000Z" }));
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("[data-enter-duel]").click();
  while (await page.locator("[data-load-more-defeated]").count()) {
    await page.locator("[data-load-more-defeated]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  }
  await expect(page.locator(".character-badge")).toHaveCount(5);
  const output = resolve("output/character-badges"); mkdirSync(output, { recursive: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    for (const badge of await page.locator(".character-badge").all()) {
      await badge.scrollIntoViewIfNeeded();
      await expect.poll(() => badge.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const bounds = await badge.evaluate(element => {
        const icon = element.getBoundingClientRect(), portrait = element.parentElement!.getBoundingClientRect();
        return { right: portrait.right - icon.right, bottom: portrait.bottom - icon.bottom, width: icon.width, label: element.getAttribute("aria-label") };
      });
      expect(bounds.right).toBeCloseTo(5); expect(bounds.bottom).toBeCloseTo(5);
      expect(bounds.width).toBeLessThanOrEqual(38); expect(bounds.label).toContain("智能核心");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: resolve(output, `directory-${width}.png`), fullPage: true });
  }
  const badge = page.locator('.character-badge').last();
  const hint = badge.locator('..').locator('.character-badge-hint');
  await badge.click();
  await expect(hint).toHaveText('智能核心');
  await expect(hint).toBeVisible();
  await expect(page.locator('#profile')).not.toBeVisible();
  await page.waitForTimeout(900);
  await badge.click();
  await page.waitForTimeout(900);
  await expect(hint).toBeVisible();
  await expect(hint).toBeHidden({ timeout: 3000 });
  await badge.focus();
  await page.keyboard.press('Enter');
  await expect(hint).toBeVisible();
  await badge.press('Space');
  await expect(hint).toBeVisible();
  const otherBadge = page.locator('.character-badge').first();
  await otherBadge.click();
  await expect(hint).toBeHidden();
  await expect(page.locator('.character-badge-hint:visible')).toHaveCount(1);
  await page.screenshot({ path: resolve(output, 'label-hint-320.png'), fullPage: true });
  await expect(page.locator('.character-badge-hint:visible')).toHaveCount(0, { timeout: 3000 });
  const topBadge = page.locator('.character-badge[data-tier="S"]').first();
  expect(await topBadge.evaluate(el => getComputedStyle(el, "::before").animationName)).toBe("badge-orbit");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await topBadge.evaluate(el => getComputedStyle(el, "::before").animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("[data-lobby-home]").click();
  await page.locator('[data-open="settings"]').click();
  await page.locator('[data-setting="reducedMotion"]').check();
  await page.locator("#settings [data-close]").click();
  await page.locator("[data-enter-duel]").click();
  expect(await topBadge.evaluate(el => getComputedStyle(el, "::before").animationName)).toBe("none");
  await page.locator('[data-invite-character="chatgpt"]').click();
  await expect(page.locator("#profile")).toBeVisible();
  await expect(page.locator('[data-profile-start="chatgpt"]')).toBeEnabled();
  expect(errors).toEqual([]);
});

test("all six tier treatments keep the icon still and progressively decorate its frame", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { characterCardMarkup } = await import("/src/lobby-screen-module.ts" as string);
    const tiers = ["D", "C", "B", "A", "S", "SS"];
    document.querySelector("#app")!.innerHTML = '<main class="lobby-shell"><section class="character-list">' + tiers.map(tier => characterCardMarkup({
      id: tier.toLowerCase(), name: tier + " 级", subtitle: "徽标边框效果", tier, tags: [], previewImage: "/characters/chatgpt/cover.png",
      portraitScales: { selection: 1.5, table: 1 }, badge: { image: "/characters/official-factions/intelligent-core.png", label: "智能核心" }
    })).join("") + "</section></main>";
  });
  await expect(page.locator(".character-badge")).toHaveCount(6);
  const styles = await page.locator(".character-badge").evaluateAll(elements => elements.map(el => ({
    frame: getComputedStyle(el, "::before").animationName, image: getComputedStyle(el.querySelector("img")!).transform,
    outer: getComputedStyle(el, "::after").content, sparkles: getComputedStyle(el.querySelector(".character-badge-sparkles")!).animationName
  })));
  expect(styles.map(style => style.image)).toEqual(Array(6).fill("none"));
  expect(styles.map(style => style.frame)).toEqual(["none", "none", "none", "badge-orbit", "badge-orbit", "badge-orbit"]);
  expect(styles.slice(4).every(style => style.outer !== "none" && style.sparkles === "badge-shimmer")).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  mkdirSync(resolve("output/character-badges"), { recursive: true });
  await page.screenshot({ path: resolve("output/character-badges/tiers.png"), fullPage: true });
});
