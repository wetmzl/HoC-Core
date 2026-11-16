import { expect, test, type Locator, type Page } from "@playwright/test";

const officialId = "d47c1184-7f10-4f45-9d67-dc24f7f9a7e1";

async function settled(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined)));
  });
  await expect(dialog).toHaveCSS("opacity", "1");
}

async function entries(page: Page): Promise<{ drawer: number; manager: number }> {
  return page.evaluate(() => (window as unknown as { launcherMotion: { drawer: number; manager: number } }).launcherMotion);
}

test("playlist changes update the open resource panel without replaying its entrance", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const state = (window as unknown as { launcherMotion: { drawer: number; manager: number } });
    state.launcherMotion = { drawer: 0, manager: 0 };
    document.addEventListener("animationstart", event => {
      if (event.animationName !== "ui-dialog-enter" || !(event.target instanceof Element)) return;
      if (event.target.matches("[data-package-drawer]")) state.launcherMotion.drawer++;
      if (event.target.matches("[data-playlist-manager]")) state.launcherMotion.manager++;
    }, true);
  });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  await page.locator("[data-open-packages]").click();
  const drawer = page.locator("[data-package-drawer]");
  await settled(drawer);
  await page.locator("[data-open-playlist-manager]").click();
  const manager = page.locator("[data-playlist-manager]");
  await settled(manager);
  await manager.locator(`[data-copy-playlist="${officialId}"]`).click();
  await expect(manager.locator("[data-manage-playlist]")).toHaveCount(2);
  const copy = manager.locator(`[data-manage-playlist]:not([data-manage-playlist="${officialId}"])`);
  const copyId = await copy.getAttribute("data-manage-playlist");
  const copyName = await copy.locator("input").inputValue();
  await page.locator("[data-close-playlist-manager]").click();
  await expect(manager).not.toBeVisible();
  await page.locator("[data-close-packages]").click();
  await expect(drawer).not.toBeVisible();
  await page.evaluate(() => { (window as unknown as { launcherMotion: { drawer: number; manager: number } }).launcherMotion = { drawer: 0, manager: 0 }; });

  await page.locator("[data-open-packages]").click();
  await settled(drawer);
  expect((await entries(page)).drawer).toBe(1);
  expect(await drawer.evaluate(node => getComputedStyle(node, "::backdrop").animationName)).toBe("ui-backdrop-enter");
  const scrollTop = await page.locator(".package-list").evaluate(node => { node.scrollTop = 320; return node.scrollTop; });
  expect(scrollTop).toBeGreaterThan(0);
  await page.locator("[data-toggle-playlist-menu]").click();
  await expect(page.locator(".playlist-menu")).toBeVisible();
  await settled(drawer);
  await info.attach("after-expanding-playlists.json", { body: JSON.stringify(await entries(page)), contentType: "application/json" });
  expect((await entries(page)).drawer).toBe(1);
  await expect(drawer).toHaveCSS("animation-name", "none");
  expect(await drawer.evaluate(node => getComputedStyle(node, "::backdrop").animationName)).toBe("none");
  await expect(page.locator("[data-toggle-playlist-menu]")).toBeFocused();
  await expect(page.locator(`[data-load-playlist="${officialId}"] .playlist-menu-copy > span`)).toHaveText("官方播放器（只读）");
  await expect(page.locator(`[data-load-playlist="${officialId}"] .playlist-menu-copy > small`)).toContainText("随游戏更新");
  await page.locator(`[data-load-playlist="${copyId}"]`).click();
  await expect(page.locator(".playlist-current-name")).toHaveText(copyName);
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await settled(drawer);
  expect((await entries(page)).drawer).toBe(1);
  expect(await drawer.evaluate(node => getComputedStyle(node, "::backdrop").animationName)).toBe("none");
  await expect(page.locator("[data-toggle-playlist-menu]")).toBeFocused();
  expect(await page.locator(".package-list").evaluate(node => node.scrollTop)).toBe(scrollTop);

  await page.locator("[data-toggle-playlist-menu]").click();
  await page.locator(`[data-load-playlist="${officialId}"]`).click();
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > small")).toHaveText("随游戏更新");
  await settled(drawer);
  expect((await entries(page)).drawer).toBe(1);
  await page.screenshot({ path: info.outputPath("stable-resource-panel.png") });

  const exit = await page.locator("[data-close-packages]").evaluate(button => {
    const dialog = button.closest("dialog")!;
    (button as HTMLButtonElement).click();
    return { open: dialog.open, modal: dialog.matches(":modal"), animation: getComputedStyle(dialog).animationName,
      backdrop: getComputedStyle(dialog, "::backdrop").animationName };
  });
  expect(exit).toEqual({ open: true, modal: true, animation: "ui-dialog-exit", backdrop: "ui-backdrop-exit" });
  await expect(drawer).not.toBeVisible();
  await page.locator("[data-open-packages]").click();
  await settled(drawer);
  expect((await entries(page)).drawer).toBe(2);
  await page.locator("[data-open-playlist-manager]").click();
  await settled(manager);
  expect(await entries(page)).toEqual({ drawer: 2, manager: 1 });
  await page.locator("[data-close-playlist-manager]").click();
  await expect(manager).not.toBeVisible();
  await page.locator("[data-open-playlist-manager]").click();
  await settled(manager);
  expect(await entries(page)).toEqual({ drawer: 2, manager: 2 });
});

test("an interrupted close of a restored panel can reopen with its real entrance animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  await page.locator("[data-open-packages]").click();
  const drawer = page.locator("[data-package-drawer]");
  await settled(drawer);
  await page.locator("[data-toggle-playlist-menu]").click();
  await settled(drawer);
  await expect(drawer).toHaveCSS("animation-name", "none");
  const result = await page.evaluate(async () => {
    const { closeUiDialog, openUiDialog } = await import(/* @vite-ignore */ "/src/presentation/dialog-motion.ts");
    const dialog = document.querySelector<HTMLDialogElement>("[data-package-drawer]")!;
    const closing = closeUiDialog(dialog);
    const guarded = dialog.open && dialog.matches(":modal") && dialog.inert;
    const exit = getComputedStyle(dialog).animationName;
    openUiDialog(dialog);
    await closing;
    return { guarded, exit, open: dialog.open, modal: dialog.matches(":modal"), inert: dialog.inert,
      animation: getComputedStyle(dialog).animationName, backdrop: getComputedStyle(dialog, "::backdrop").animationName };
  });
  expect(result).toEqual({ guarded: true, exit: "ui-dialog-exit", open: true, modal: true, inert: false,
    animation: "ui-dialog-enter", backdrop: "ui-backdrop-enter" });
  await settled(drawer);
  await page.locator("[data-close-packages]").click();
  await expect(drawer).not.toBeVisible();
});
