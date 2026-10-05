import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import archived from "../../src/test/fixtures/archived-long-term-save.json" with { type: "json" };

async function writeSave(page: Page, id: "long-term" | "runtime", data: unknown) {
  await page.evaluate(async ({ id, data }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("house-of-chances");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("saves", "readwrite");
      transaction.objectStore("saves").put({ id, data });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  }, { id, data });
}

async function readSave(page: Page, id: "long-term" | "runtime") {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("house-of-chances"); request.onsuccess = () => resolve(request.result); });
    return new Promise<unknown>((resolve) => { const request = db.transaction("saves", "readonly").objectStore("saves").get(id); request.onsuccess = () => { db.close(); resolve(request.result?.data ?? null); }; });
  }, id);
}

async function installPlugin(page: Page) {
  const files = {
    "module.json": Buffer.from(JSON.stringify({ module: "module.js", style: "style.css", provides: [] })),
    "module.js": Buffer.from("globalThis.__recoveryPluginRuns = (globalThis.__recoveryPluginRuns || 0) + 1; export function register() { return { handlers: [], createRuntime() { return {}; } }; }"),
    "style.css": Buffer.from(".recovery-test {}")
  };
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "recovery-plugin", version: "1.0.0" },
    metadata: { title: "恢复验证插件", description: "中性测试", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion: 2, entry: "module.json", requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })),
    extensions: {}
  };
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "recovery.hocpkg", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), ...files })) });
  await page.locator("[data-import-next]").click();
  await page.locator('.package-card[data-package-id="example/recovery-plugin"]').getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
}

test("不支持的长期档在第三方代码之前恢复，失败与取消不覆盖原件", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  // Create the database, then return to the launcher without accepting the adult warning.
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  await page.reload();
  await installPlugin(page);
  const invalid = { ...archived, schemaVersion: 8 };
  await writeSave(page, "long-term", invalid);
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("main.error-shell")).toBeVisible();
  await expect(page.locator("[data-migrate-invalid-save]")).toHaveCount(0);
  await expect(page.locator("#third-party-content-warning")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).__recoveryPluginRuns ?? 0)).toBe(0);
  const download = page.waitForEvent("download");
  await page.locator("[data-export-invalid-save]").click();
  expect(JSON.parse(readFileSync((await (await download).path())!, "utf8"))).toEqual(invalid);
  await page.locator("[data-reset-invalid-save]").click();
  await page.locator('[data-game-dialog-choice="cancel"]').click();
  expect(await readSave(page, "long-term")).toEqual(invalid);
  await page.locator("[data-retry]").click();
  await expect(page.locator("[data-error-status]")).toContainText("未被修改");
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (globalThis as any).__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (value, key) { if (value.id === "long-term") throw new Error("simulated storage failure"); return put.call(this, value, key); };
  });
  await page.locator("[data-reset-invalid-save]").click();
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator("[data-error-status]")).toContainText("未被覆盖");
  expect(await readSave(page, "long-term")).toEqual(invalid);
  expect(await page.evaluate(() => (globalThis as any).__recoveryPluginRuns ?? 0)).toBe(0);
  await page.evaluate(() => (globalThis as any).__restorePut());
  await page.locator("[data-return-launcher]").click();
  await expect(page.locator("main.launcher-shell")).toBeVisible();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("[data-reset-invalid-save]").click();
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator("#third-party-content-warning")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).__recoveryPluginRuns ?? 0)).toBe(0);
  await page.locator("[data-acknowledge-third-party-content]").click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).__recoveryPluginRuns)).toBe(1);
});

test("归档版直接读取，旧运行时每个舍弃入口都须确认", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  await writeSave(page, "long-term", archived);
  const runtime = { format: "house-of-chances-runtime", schemaVersion: 8, marker: "archived-match" };
  await writeSave(page, "runtime", runtime);
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("[data-game-dialog]")).toContainText("只舍弃这局牌");
  await page.locator('[data-game-dialog-choice="cancel"]').click();
  await expect(page.locator("main.error-shell")).toBeVisible();
  expect(await readSave(page, "long-term")).toEqual(archived);
  expect(await readSave(page, "runtime")).toEqual(runtime);
  await page.locator("[data-reset-invalid-runtime]").click();
  await page.locator('[data-game-dialog-choice="cancel"]').click();
  expect(await readSave(page, "runtime")).toEqual(runtime);
  await page.locator("[data-reset-invalid-runtime]").click();
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  expect(await readSave(page, "long-term")).toEqual(archived);
  expect(await readSave(page, "runtime")).toBeNull();
});
