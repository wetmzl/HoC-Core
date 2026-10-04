import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

test("旧插件明确提示不兼容且启动前不执行模块", async ({ page }) => {
  const files = {
    "module.json": Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [] })),
    "plugin.js": Buffer.from("window.__legacyExecuted = true; export function register() { throw new Error('legacy executed'); }"),
    "plugin.css": Buffer.from("/* fixture */")
  };
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: "legacy-plugin", version: "1.0.0" },
    metadata: { title: "旧接口测试", description: "Legacy API fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion: 1, entry: "module.json", requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })), extensions: {}
  };
  await page.goto("/");
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "legacy.hocpkg", mimeType: "application/zip", buffer: Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) })) });
  await page.getByRole("button", { name: "安装所选包" }).click();
  const card = page.locator('.package-card[data-package-id="test/legacy-plugin"]');
  await expect(card).toContainText("插件接口版本不兼容");
  await card.getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("#third-party-content-warning")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__legacyExecuted)).toBeUndefined();
  await page.locator("[data-acknowledge-third-party-content]").click();
  await page.getByRole("button", { name: "我已成年并继续" }).click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__legacyExecuted)).toBeUndefined();
});

test("历史详情为扩展提供独立容器并在关闭或替换时释放", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { mountHistoryScreen } = await import("/src/history-screen.ts");
    document.querySelectorAll("body > div").forEach((node) => (node as HTMLElement).style.display = "none");
    const root = document.createElement("div"); document.body.append(root);
    const log: string[] = []; (window as any).__extensionEvents = log;
    const records = ["first", "second"].map((id) => ({ id, timestamp: "2026-09-28T00:00:00Z", opponentId: "chatgpt", winner: "player", escaped: false, finalRoulette: { player: { bullets: 0, capacity: 6 }, opponent: { bullets: 1, capacity: 6 } }, busts: { player: 0, opponent: 0 }, blackjacks: { player: 0, opponent: 0 } }));
    const signal = new AbortController();
    const context = {
      root, getSave: () => ({ history: records }), contributions: ["a", "b"].map((name) => ({
        async mountHistoryDetail(_context: unknown, container: HTMLElement, record: any, signal: AbortSignal) {
          log.push(`mount:${record.id}:${name}`);
          signal.addEventListener("abort", () => log.push(`abort:${record.id}:${name}`), { once: true });
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (!signal.aborted) container.textContent = `${record.id}:${name}`;
          return () => log.push(`dispose:${record.id}:${name}`);
        }
      })), navigateToLobby: async () => undefined
    };
    await mountHistoryScreen(context, signal.signal);
  });
  await page.locator('[data-history-id="first"]').click();
  await expect(page.locator(".history-detail-extension")).toHaveCount(2);
  await page.locator("[data-history-close]").click();
  await page.locator('[data-history-id="second"]').click();
  await expect(page.locator(".history-detail-extension")).toHaveText(["second:a", "second:b"]);
  await expect(page.locator(".history-stats")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionEvents)).toEqual(expect.arrayContaining(["abort:first:a", "abort:first:b", "dispose:first:a", "dispose:first:b"]));
  await page.locator("[data-history-close]").click();
  await expect(page.locator(".history-detail-extension")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__extensionEvents)).toEqual(expect.arrayContaining(["dispose:second:a", "dispose:second:b"]));
});
