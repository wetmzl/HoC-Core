import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";

test("写入 HTML 测试快照不会重载正在运行的页面", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(() => { (window as any).__outputReloadProbe = "still-mounted"; });
  const snapshot = info.outputPath("trace-snapshot.html");
  const reloaded = page.waitForEvent("framenavigated", {
    predicate: frame => frame === page.mainFrame(), timeout: 1_000
  }).then(() => true, () => false);
  try {
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, "<!doctype html><title>Neutral trace snapshot</title>");
    expect(await reloaded).toBe(false);
    expect(await page.evaluate(() => (window as any).__outputReloadProbe)).toBe("still-mounted");
    await expect(page.locator("[data-start-game]")).toBeEnabled();
  } finally {
    await rm(snapshot, { force: true });
  }
});
