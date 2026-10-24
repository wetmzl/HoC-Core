import { expect, test } from "@playwright/test";
import builtinIndex from "../../public/characters/packages.json" with { type: "json" };

test("installed production PWA starts and resumes a match offline after HTTP cache eviction", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.getByRole("button", { name: "我已成年并继续" }).click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const cached = await page.evaluate(async () => {
    const keys = await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)));
    return keys.flat();
  });
  expect(cached).toContain("/characters/packages.json");
  for (const entry of builtinIndex.packages) expect(cached).toContain(`/characters/${entry.manifest}`);
  // Package media belongs to OPFS; precaching it would duplicate installed content.
  expect(cached.filter(path => path.startsWith("/characters/")).every(path => path.endsWith(".json"))).toBe(true);
  const session = await context.newCDPSession(page);
  await session.send("Network.clearBrowserCache");
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await expect(page.locator(".package-card[data-package-state=enabled]")).toHaveCount(builtinIndex.packages.length);
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator("[data-enter-duel]").click();
  await page.locator("[data-invite-character]").first().click();
  await page.locator("[data-profile-start]").click();
  await expect(page.locator("main.table-shell")).toBeVisible();
  await expect(page.locator(".player-zone .card")).toHaveCount(2);
  expect(await page.locator(".character-portrait").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("main.table-shell")).toBeVisible();
  await expect(page.locator(".player-zone .card")).toHaveCount(2);
  expect(errors).toEqual([]);
});
