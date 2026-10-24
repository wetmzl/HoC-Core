import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

function plugin(name: string, title: string, apiVersion = 7, fail = false, modules = 1) {
  const files: Record<string, Buffer> = {
    "plugin.js": Buffer.from(fail ? 'export function register(){throw new Error("fixture failure");}' : 'export function register(){return {handlers:[],createRuntime(){return {};}}}'),
    "plugin.css": Buffer.from("/* neutral credits fixture */")
  };
  const resources = Array.from({ length: modules }, (_, index) => {
    const entry = `module-${index}.json`;
    files[entry] = Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [], credits: { paragraphs: [[{ text: `<img src=x onerror="window.__creditsInjected=true"> ${name}-${index}` }, { text: "示例链接", href: "https://example.com/?a=1&b=2" }]] } }));
    return { id: `module-${index}`, type: "plugin.module", apiVersion, entry, requires: [] };
  });
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: name, version: "1.0.0" },
    metadata: { title, description: "中性致谢契约验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] }, resources,
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })), extensions: {}
  };
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}

async function start(page: Page) {
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator('[data-open="credits"]').click();
}
async function leave(page: Page) {
  await page.locator("#credits [data-close]").click();
  await page.locator("[data-exit-launcher]").click();
  await expect(page.locator("[data-start-game]")).toBeVisible();
}

test.use({ actionTimeout: 15_000 });

test("声明致谢按插件分组排序，安全渲染并跟随插件启停和运行时释放", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async w => { await w.locator("[data-acknowledge-third-party-content]").click(); });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async w => { await w.locator("[data-acknowledge-adult-content]").click(); });
  await page.goto("/");
  await start(page);
  await expect(page.locator("[data-plugin-credits]")).toHaveCount(0);
  await leave(page);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  const packages = {
    "a.hocpkg": plugin("credits-a", "<示例甲>", 7, false, 2),
    "b.hocpkg": plugin("credits-b", "示例乙"),
    "failed.hocpkg": plugin("credits-failed", "失败插件", 7, true),
    "legacy.hocpkg": plugin("credits-legacy", "旧版声明", 6)
  };
  await page.locator("[data-import-file]").setInputFiles({ name: "neutral-credits.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(packages)) });
  await page.getByRole("button", { name: "安装所选包" }).click();
  for (const id of ["credits-a", "credits-b", "credits-failed", "credits-legacy"]) {
    await page.locator(`[data-package-action="enable"][data-package-id="test/${id}"]`).click();
    await expect(page.locator(`.package-card[data-package-id="test/${id}"]`)).toHaveAttribute("data-package-state", "enabled");
  }
  const up = page.locator('[data-plugin-move="up"][data-package-id="test/credits-b"]');
  await up.click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page);
  const sections = page.locator("#credits [data-plugin-credits]");
  await expect(sections).toHaveCount(2);
  const order = await sections.evaluateAll(els => els.map(el => el.getAttribute("data-plugin-credits")));
  expect(order.indexOf("test/credits-b")).toBeLessThan(order.indexOf("test/credits-a"));
  const first = page.locator('[data-plugin-credits="test/credits-a"]');
  await expect(first.locator("h3")).toHaveText("<示例甲>");
  await expect(first.locator("p")).toHaveCount(2);
  await expect(first.locator("p").first()).toContainText('<img src=x onerror="window.__creditsInjected=true"> credits-a-0');
  await expect(first.locator("img")).toHaveCount(0);
  await expect(first.locator("a").first()).toHaveAttribute("target", "_blank");
  await expect(first.locator("a").first()).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => (window as any).__creditsInjected)).toBeUndefined();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(viewport);
    expect(await page.locator("#credits").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await leave(page); await start(page); await expect(sections).toHaveCount(2);
  await leave(page);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('[data-package-action="disable"][data-package-id="test/credits-a"]').click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page); await expect(first).toHaveCount(0); await expect(sections).toHaveCount(1);
  await leave(page);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('[data-package-action="enable"][data-package-id="test/credits-a"]').click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page); await expect(first.locator("p")).toHaveCount(2); await expect(sections).toHaveCount(2);
  await leave(page);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('[data-package-action="remove"][data-package-id="test/credits-a"]').click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page); await expect(first).toHaveCount(0);
});
