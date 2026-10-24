import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
function plugin() {
  const fields = [
    { id: "enabled", label: "启用提示", description: "立即更新", apply: "immediate", default: true, schema: { type: "boolean" } },
    { id: "volume", label: "提示强度", description: "0 至 1", apply: "immediate", default: .6, schema: { type: "number", minimum: 0, maximum: 1 } },
    { id: "mode", label: "展示模式", description: "下次启动更新", apply: "restart", default: "简洁", schema: { type: "string", enum: ["简洁", "完整"] } },
    { id: "caption", label: "提示文字", description: "最多八个字符", apply: "immediate", default: "提示", schema: { type: "string", minLength: 1, maxLength: 8 } }
  ];
  const files = {
    "module.json": Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [], settings: { version: 1, fields } })),
    "plugin.js": Buffer.from(`export function register(host) { globalThis.__settingsProbe = {get:id=>host.settings.get(id),events:[]}; host.settings.subscribe(values=>globalThis.__settingsProbe.events.push(values)); return {handlers:[],createRuntime(){return {};}}; }`),
    "plugin.css": Buffer.from("/* Neutral settings fixture */")
  };
  const manifest = { format: "house-of-chances-hocpkg", formatVersion: 1, identity: { authorId: "test", packageName: "settings", version: "1.0.0" }, metadata: { title: "中性设置验证", description: "公开契约验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] }, resources: [{ id: "module", type: "plugin.module", apiVersion: 3, entry: "module.json", requires: [] }], files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })), extensions: {} };
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}
async function start(page: Page) {
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator('[data-open="settings"]').click();
  const form = page.locator('[data-plugin-settings="test/settings"]');
  if (await form.count()) {
    await expect(form).not.toHaveAttribute("open", "");
    await expect(form.getByLabel("提示强度")).not.toBeVisible();
    await form.locator("summary").click();
    await expect(form.getByLabel("提示强度")).toBeVisible();
  }
}
test("插件设置校验、持久化、启动快照、保存失败与启停恢复", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async w => { await w.locator("[data-acknowledge-third-party-content]").click(); });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async w => { await w.locator("[data-acknowledge-adult-content]").click(); });
  await page.goto("/"); await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "settings.hocpkg", mimeType: "application/zip", buffer: plugin() });
  await page.getByRole("button", { name: "安装所选包" }).click();
  await page.locator('[data-package-id="test/settings"]').getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click(); await start(page);
  const form = page.locator('[data-plugin-settings="test/settings"]');
  await expect(form.getByLabel("启用提示")).toBeChecked();
  await form.locator("summary").click(); await expect(form.getByLabel("提示强度")).not.toBeVisible();
  await form.locator("summary").click();
  await form.getByLabel("提示强度").fill("2"); await form.getByRole("button", { name: "保存插件设置" }).click();
  await expect(form.getByRole("status")).toContainText("不得大于");
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.6);
  await form.getByLabel("提示强度").fill("0.25"); await form.getByLabel("展示模式").selectOption(JSON.stringify("完整")); await form.getByLabel("提示文字").fill("新提示");
  await form.getByRole("button", { name: "保存插件设置" }).click(); await expect(form.getByRole("status")).toContainText("已保存");
  await expect(form).toHaveAttribute("open", "");
  expect(await page.evaluate(() => [(window as any).__settingsProbe.get("volume"), (window as any).__settingsProbe.get("mode"), (window as any).__settingsProbe.get("caption")])).toEqual([.25, "简洁", "新提示"]);
  await page.evaluate(async () => {
    const { PersistenceService } = await import("/src/persistence/save-service.ts");
    (window as any).__saveMethod = PersistenceService.prototype.saveLongTerm;
    PersistenceService.prototype.saveLongTerm = async () => { throw new Error("模拟写入失败"); };
  });
  await form.getByLabel("提示强度").fill("0.4"); await form.getByRole("button", { name: "保存插件设置" }).click();
  await expect(form.getByRole("status")).toContainText("模拟写入失败");
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.25);
  await page.evaluate(async () => { const { PersistenceService } = await import("/src/persistence/save-service.ts"); PersistenceService.prototype.saveLongTerm = (window as any).__saveMethod; });
  await page.reload(); await start(page); await expect(form.getByLabel("提示强度")).toHaveValue("0.25");
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("mode"))).toBe("完整");
  await page.locator('#settings [data-close]').click(); await page.locator("[data-exit-launcher]").click();
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator('[data-package-id="test/settings"]').getByRole("button", { name: "禁用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click(); await start(page); await expect(form).toHaveCount(0);
  await page.locator('#settings [data-close]').click(); await page.locator("[data-exit-launcher]").click();
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator('[data-package-id="test/settings"]').getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click(); await start(page); await expect(form.getByLabel("提示强度")).toHaveValue("0.25");
  await form.getByRole("button", { name: "恢复本插件默认值" }).click(); await expect(form.getByLabel("提示强度")).toHaveValue("0.6");
});
