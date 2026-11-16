import { test, expect } from "@playwright/test";
import { skipStory } from "./story-platform-fixture";

for (const width of [320, 1280]) {
  test(`new players can manage skills and play without builtin tutorial popovers (${width}px)`, async ({ page }, info) => {
    await page.addLocatorHandler(page.locator("[data-story-player]"), async () => { await skipStory(page); });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator("[data-start-game]")).toBeEnabled();
    await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
      save.settings.reducedMotion = true;
      save.settings.soundEnabled = false;
      await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
      (window as any).__unexpectedTutorials = [];
      new MutationObserver(() => {
        for (const surface of document.querySelectorAll("#tutorial-popover")) {
          (window as any).__unexpectedTutorials.push(surface.getAttribute("data-tutorial-id"));
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.locator("[data-start-game]").click();
    await expect(page.locator("#adult-content-warning")).toBeVisible();
    await page.locator("[data-acknowledge-adult-content]").click();
    await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
    await page.locator('[data-open="skills"]').click();
    await expect(page.locator("#skills")).toBeVisible();
    await page.locator('[data-skill-tab="talents"]').click();
    await expect(page.locator("#talent-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("[data-enter-duel]").click();
    await page.locator("[data-invite-character]").first().click();
    await page.locator("#profile [data-profile-start]").click();
    await expect(page.locator("main.table-playing")).toBeVisible();
    const drawer = page.locator(".skill-drawer-toggle");
    await drawer.press("End");
    await page.locator("[data-skill-info]").first().click();
    await expect(page.locator("#skill-info-dialog")).toBeVisible();
    await page.locator("[data-skill-close]").click();
    await drawer.press("Home");
    await page.locator('[data-action*="PLAYER_STAND"]').click();
    await expect(page.locator("#tutorial-popover")).toHaveCount(0);
    const saved = await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      return (await (await load("/src/persistence/factory.ts")).createPersistenceService().loadLongTerm());
    });
    expect(saved.skipTutorial).toBe(false);
    expect(saved.tutorialProgress.completedIds).toEqual(["adult-content-warning"]);
    expect(await page.evaluate(() => (window as any).__unexpectedTutorials)).toEqual([]);
    await page.screenshot({ path: info.outputPath("table-without-onboarding.png") });
  });
}
