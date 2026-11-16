import { expect, test } from "@playwright/test";

test("the embedded default template remains available on a cold offline launcher", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  await expect(page.locator("[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
  await expect(page.locator("[data-embedded-default-playlist] > small")).toHaveText("随游戏更新");
  await page.locator("[data-close-packages]").click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if ((await (await caches.open(name)).keys()).some(request => new URL(request.url).pathname === "/embedded/default-playlist.json")) return true;
    }
    return false;
  })).toBe(true);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  await expect(page.locator("[data-embedded-default-playlist] > small")).toHaveText("随游戏更新");
  await expect(page.locator('.package-card[data-package-id="hoc-core/official-story"]')).toHaveAttribute("data-package-state", "enabled");
});
