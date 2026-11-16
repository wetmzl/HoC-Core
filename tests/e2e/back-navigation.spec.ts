import { skipStory } from "./story-platform-fixture";
import { expect, test, type Page } from "@playwright/test";

async function launcher(page: Page): Promise<void> {
  await page.goto("/?back-navigation-e2e=1");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
}

async function browserBack(page: Page): Promise<void> {
  await page.evaluate(() => window.history.back());
}

/** Seed the public runtime contract, then enter through the actual app host. */
async function start(page: Page, table = false): Promise<void> {
  await launcher(page);
  await page.evaluate(async table => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave();
    save.skipTutorial = true;
    save.settings.soundEnabled = false;
    save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repository.saveLongTerm(save);
    if (table) {
      const { PLAYER_SKILL_DEFINITIONS } = await load("/src/core/skills/definitions.ts");
      const ids = PLAYER_SKILL_DEFINITIONS.filter((skill: any) => skill.category === "active" && skill.drop.enabled).map((skill: any) => skill.id);
      const { createMatch } = await load("/src/core/match/reducer.ts");
      const base = createMatch("neutral-back-navigation", { opponentId: "chatgpt", unlockedPlayerSkillIds: ids, skillDeckIds: ids });
      const match = { ...base, playerSkills: { ...base.playerSkills, drawCount: 2 }, round: { ...base.round, phase: "turns", currentActor: "player" } };
      await repository.saveRuntime(createRuntimeSave(match));
    } else await repository.deleteRuntime();
  }, table);
  await page.locator("[data-start-game]").click();
  await expect(page.locator(table ? ".table-shell" : ".lobby-menu-shell")).toBeVisible();
  if (!table) {
    // This test exercises character/menu back layers after the first-Duel story.
    // The story's own confirmation is verified in story-feedback.spec.ts.
    await page.locator("[data-enter-duel]").click();
    const story = page.locator("[data-story-player]");
    await expect(story).toBeVisible();
    await skipStory(page);
    await expect(story).toHaveCount(0);
    await page.locator("[data-lobby-home]").click();
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  }
}

test("浏览器返回与 Esc 逐层关闭资源弹窗，重复操作和刷新不累积历史", async ({ page }) => {
  await launcher(page);
  const initialLength = await page.evaluate(() => history.length);
  const originalUrl = page.url();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator("[data-open-packages]").click();
    const resources = page.locator("[data-package-drawer]");
    await expect(resources).toBeVisible();
    await page.locator("[data-open-playlist-manager]").click();
    const manager = page.locator("[data-playlist-manager]");
    await expect(manager).toBeVisible();
    if (attempt % 2) await page.keyboard.press("Escape");
    else await browserBack(page);
    await expect(manager).not.toBeVisible();
    await expect(resources).toBeVisible();
    if (attempt % 2) await browserBack(page);
    else await page.keyboard.press("Escape");
    await expect(resources).not.toBeVisible();
    await expect(page.locator(".launcher-shell")).toBeVisible();
    expect(page.url()).toBe(originalUrl);
    expect(await page.evaluate(() => history.length)).toBe(initialLength);
    await page.reload();
    await expect(page.locator("[data-start-game]")).toBeEnabled();
    expect(await page.evaluate(() => history.length)).toBe(initialLength);
  }
});

test("较早的原生弹窗重新置顶后返回只关闭实际顶层", async ({ page }) => {
  await launcher(page);
  await page.locator("[data-open-packages]").click();
  await page.locator("[data-open-playlist-manager]").click();
  // Reopen the earlier sibling above the later one, matching native top-layer order.
  await page.evaluate(() => {
    const resources = document.querySelector<HTMLDialogElement>("[data-package-drawer]")!;
    resources.close();
    resources.showModal();
  });
  await browserBack(page);
  await expect(page.locator("[data-package-drawer]")).not.toBeVisible();
  await expect(page.locator("[data-playlist-manager]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".launcher-shell")).toBeVisible();
});

test("角色选择和历史页面返回主菜单，再返回启动器，重启不残留旧处理器", async ({ page }) => {
  await start(page);
  const length = await page.evaluate(() => history.length);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator("[data-enter-duel]").click();
    await expect(page.locator(".lobby-character-shell")).toBeVisible();
    await browserBack(page);
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
    await page.locator("[data-open-history]").click();
    await expect(page.locator(".history-shell")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
    await browserBack(page);
    await expect(page.locator(".launcher-shell")).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.locator("[data-start-game]").click();
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  }
});

test("牌局先收起情报和技能抽屉，取消退出后继续，确认退出走原有结算", async ({ page }) => {
  await start(page, true);
  await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
  await page.locator(".character-intel > summary").click();
  await expect(page.locator(".character-intel")).toHaveJSProperty("open", true);
  await browserBack(page);
  await expect(page.locator(".character-intel")).toHaveJSProperty("open", false);
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  const skills = page.locator(".skill-drawer-toggle");
  await skills.click();
  await expect(skills).toHaveAttribute("aria-expanded", "true");
  await browserBack(page);
  await expect(skills).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await browserBack(page);
  const confirmation = page.locator("[data-game-dialog]");
  await expect(confirmation).toContainText("离开本场牌局");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator(".table-shell")).toBeVisible();
  await browserBack(page);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "离开牌局", exact: true }).click();
  await expect(page.locator(".summary-shell")).toBeVisible();
  await browserBack(page);
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const persisted = await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repository = createPersistenceService();
    return { save: await repository.loadLongTerm(), runtime: await repository.loadRuntime() };
  });
  expect(persisted.runtime).toBeNull();
  expect(persisted.save!.history).toHaveLength(1);
  expect(persisted.save!.history[0].escaped).toBe(true);
});

test("强制技能选牌期间返回不能跳过选择或离开牌桌", async ({ page }) => {
  await start(page, true);
  await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
  await expect(page.locator(".skill-draw-card")).toHaveCount(3);
  await browserBack(page);
  await expect(page.locator(".skill-draw-modal")).toBeVisible();
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await expect(page.locator(".table-shell")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".skill-draw-modal")).toBeVisible();
  await page.locator(".skill-draw-card").first().click();
  await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
  await browserBack(page);
  await expect(page.locator("[data-game-dialog]")).toContainText("离开本场牌局");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".table-shell")).toBeVisible();
});

test("启动器根返回离开站点，前进恢复不会自动关闭新浮层", async ({ page }) => {
  await page.route("**/previous-back-e2e", route => route.fulfill({ contentType: "text/html", body: "<main>previous page</main>" }));
  await page.goto("/previous-back-e2e");
  await launcher(page);
  await browserBack(page);
  await expect(page).toHaveURL(/\/previous-back-e2e$/);
  await page.goForward();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  await expect(page.locator("[data-package-drawer]")).toBeVisible();
  await browserBack(page);
  await expect(page.locator("[data-package-drawer]")).not.toBeVisible();
  await expect(page.locator(".launcher-shell")).toBeVisible();
});

test("无前站根返回不留下保护层，重新打开浮层仍可返回", async ({ page }) => {
  await launcher(page);
  await browserBack(page);
  // Chromium may keep about:blank as a preceding entry; a standalone PWA may
  // instead remain at base. Neither case should leave the synthetic guard.
  await expect.poll(() => page.evaluate(() => history.state?.__hocBackNavigation?.position)).not.toBe("guard");
  if (page.url() === "about:blank") await page.goForward();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  await expect.poll(() => page.evaluate(() => history.state?.__hocBackNavigation?.position)).toBe("guard");
  await browserBack(page);
  await expect(page.locator("[data-package-drawer]")).not.toBeVisible();
  await expect(page.locator(".launcher-shell")).toBeVisible();
});
