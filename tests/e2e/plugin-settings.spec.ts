import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
function plugin() {
  const fields = [
    { id: "enabled", label: "启用提示", description: "立即更新", apply: "immediate", default: true, schema: { type: "boolean" } },
    { id: "volume", label: "提示强度", description: "0 至 1", apply: "immediate", default: .6, schema: { type: "number", minimum: 0, maximum: 1, multipleOf: .01 } },
    { id: "count", label: "提示次数", description: "1 至 5", apply: "immediate", default: 3, schema: { type: "integer", minimum: 1, maximum: 5 } },
    { id: "fine", label: "连续强度", description: "不限定步长", apply: "immediate", default: .625, schema: { type: "number", minimum: 0, maximum: 1 } },
    { id: "limit", label: "提示上限", description: "仅有上限", apply: "immediate", default: 1, schema: { type: "number", maximum: 2 } },
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
async function setSlider(page: Page, label: string, value: string) {
  await page.getByRole("slider", { name: label, exact: true }).evaluate((node, value) => {
    const input = node as HTMLInputElement;
    input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
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
  await expect(form.getByRole("button", { name: "保存插件设置" })).toHaveCount(0);
  await form.getByLabel("启用提示").uncheck(); await expect(form.getByLabel("启用提示")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("enabled"))).toBe(false);
  await form.locator("summary").click(); await expect(form.getByLabel("提示强度")).not.toBeVisible();
  await form.locator("summary").click();
  const slider = form.getByRole("slider", { name: "提示强度", exact: true });
  const readout = slider.locator("..").locator(".plugin-setting-value");
  await expect(slider).toHaveAttribute("min", "0"); await expect(slider).toHaveAttribute("max", "1"); await expect(slider).toHaveAttribute("step", "0.01");
  // Input events alone remain drafts until the edited control emits change.
  await form.locator('[data-plugin-setting="limit"], [data-plugin-setting="caption"]').evaluateAll(inputs => {
    for (const node of inputs) {
      const input = node as HTMLInputElement; input.value = input.type === "number" ? "3" : "草稿";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await setSlider(page, "提示强度", "0.64"); await expect(readout).toHaveText("0.64");
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.6);
  await slider.dispatchEvent("change"); await expect(slider).toBeEnabled();
  await expect(form.getByRole("status")).toContainText("已保存");
  expect(await page.evaluate(() => [(window as any).__settingsProbe.get("volume"), (window as any).__settingsProbe.get("caption"), (window as any).__settingsProbe.get("limit")])).toEqual([.64, "提示", 1]);
  await expect(form.getByLabel("提示文字")).toHaveValue("草稿"); await expect(form.getByLabel("提示上限")).toHaveValue("3");
  await slider.focus(); await slider.press("ArrowRight"); await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue("0.65"); await expect(readout).toHaveText("0.65"); await expect(slider).toBeFocused();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.65);
  await slider.press("Home"); await expect(slider).toBeEnabled(); await slider.press("ArrowLeft"); await expect(slider).toHaveValue("0");
  await slider.press("End"); await expect(slider).toBeEnabled(); await slider.press("ArrowRight"); await expect(slider).toHaveValue("1");
  const count = form.getByRole("slider", { name: "提示次数", exact: true });
  await count.focus(); await count.press("ArrowRight"); await expect(count).toBeEnabled(); await expect(count).toHaveValue("4");
  await expect(form.getByRole("slider", { name: "连续强度", exact: true })).toHaveValue("0.625");
  await expect(form.getByLabel("提示上限")).toHaveAttribute("type", "number");
  await form.getByLabel("提示上限").dispatchEvent("change");
  await expect(form.getByRole("status")).toContainText("不得大于");
  await expect(form.getByLabel("提示上限")).toHaveValue("1");
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(1);
  await form.getByLabel("提示上限").fill("2"); await form.getByLabel("提示上限").blur(); await expect(form.getByLabel("提示上限")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("limit"))).toBe(2);
  await setSlider(page, "提示强度", "0.25"); await slider.dispatchEvent("change"); await expect(slider).toBeEnabled();
  await form.getByLabel("展示模式").selectOption(JSON.stringify("完整")); await expect(form.getByLabel("展示模式")).toBeEnabled();
  await expect(form.getByRole("status")).toContainText("下次启动游戏生效");
  await form.getByLabel("提示文字").fill("新提示"); await form.getByLabel("提示文字").blur(); await expect(form.getByLabel("提示文字")).toBeEnabled();
  await expect(form.getByRole("status")).toHaveText("插件设置已保存。");
  await expect(form).toHaveAttribute("open", "");
  expect(await page.evaluate(() => [(window as any).__settingsProbe.get("volume"), (window as any).__settingsProbe.get("mode"), (window as any).__settingsProbe.get("caption")])).toEqual([.25, "简洁", "新提示"]);
  expect(await page.evaluate(() => [(window as any).__settingsProbe.get("count"), (window as any).__settingsProbe.get("fine")])).toEqual([4, .625]);
  await page.evaluate(async () => {
    const { PersistenceService } = await import("/src/persistence/save-service.ts");
    (window as any).__saveMethod = PersistenceService.prototype.saveLongTerm;
    PersistenceService.prototype.saveLongTerm = async () => { throw new Error("模拟写入失败"); };
  });
  await setSlider(page, "提示强度", "0.4"); await slider.dispatchEvent("change");
  await expect(form.getByRole("status")).toContainText("模拟写入失败");
  await expect(readout).toHaveText("0.25"); await expect(slider).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.25);
  await form.getByLabel("启用提示").click(); await expect(form.getByLabel("启用提示")).toBeEnabled();
  await expect(form.getByLabel("启用提示")).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("enabled"))).toBe(false);
  await form.getByLabel("展示模式").selectOption(JSON.stringify("简洁")); await expect(form.getByLabel("展示模式")).toBeEnabled();
  await expect(form.getByLabel("展示模式")).toHaveValue(JSON.stringify("完整"));
  await form.getByLabel("提示文字").fill("失败值"); await form.getByLabel("提示文字").blur(); await expect(form.getByLabel("提示文字")).toBeEnabled();
  await expect(form.getByLabel("提示文字")).toHaveValue("新提示");
  await expect(form.getByRole("status")).toContainText("模拟写入失败");
  await page.evaluate(async () => { const { PersistenceService } = await import("/src/persistence/save-service.ts"); PersistenceService.prototype.saveLongTerm = (window as any).__saveMethod; });
  await form.getByLabel("启用提示").check(); await expect(form.getByLabel("启用提示")).toBeEnabled();
  await form.getByLabel("启用提示").uncheck(); await expect(form.getByLabel("启用提示")).toBeEnabled();
  await setSlider(page, "提示强度", "0.3"); await slider.dispatchEvent("change"); await expect(slider).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__settingsProbe.get("volume"))).toBe(.3);
  await setSlider(page, "提示强度", "0.25"); await slider.dispatchEvent("change"); await expect(slider).toBeEnabled();
  await page.reload(); await start(page); await expect(form.getByLabel("提示强度")).toHaveValue("0.25");
  await expect(readout).toHaveText("0.25"); await expect(count).toHaveValue("4");
  await expect(form.getByLabel("启用提示")).not.toBeChecked(); await expect(form.getByLabel("提示上限")).toHaveValue("2");
  await expect(form.getByLabel("提示文字")).toHaveValue("新提示");
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
  await expect(readout).toHaveText("0.6"); await expect(count).toHaveValue("3");
  await expect(form.getByLabel("启用提示")).toBeChecked(); await expect(form.getByLabel("提示上限")).toHaveValue("1");
  await expect(form.getByLabel("提示文字")).toHaveValue("提示");
});
