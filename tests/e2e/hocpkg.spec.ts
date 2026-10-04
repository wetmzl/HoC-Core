import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";

test("hocpkg 在 Chromium OPFS 预览、取消、安装与导出", async ({ page }) => {
  test.setTimeout(300_000);
  let nativeDialogs = 0;
  page.on("dialog", (dialog) => { nativeDialogs += 1; void dialog.dismiss(); });
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const body = Buffer.from('{"hello":"hocpkg"}');
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "e2e", packageName: "test-plugin", version: "1.0.0" },
    metadata: { title: "测试插件包", description: "E2E", tags: [], creators: [{ displayName: "E2E", roles: ["design"] }] },
    resources: [{ id: "data", type: "test.data", apiVersion: 1, entry: "resources/data.json", requires: [] }],
    files: [{ path: "resources/data.json", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "application/json" }],
    extensions: {}
  };
  const bytes = zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), "resources/data.json": body });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 240_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "test.hocpkg", mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await expect(page.locator("[data-import-dialog]")).toContainText("e2e/test-plugin");
  await expect(page.locator('.package-card[data-package-id="e2e/test-plugin"]')).toHaveCount(0);
  await page.locator("[data-import-cancel]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await page.locator("[data-import-file]").setInputFiles({ name: "test.hocpkg", mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await expect(page.locator("[data-import-dialog]")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await page.locator("[data-import-file]").setInputFiles({ name: "test.hocpkg", mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  const card = page.locator('.package-card[data-package-id="e2e/test-plugin"]');
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await card.getByRole("button", { name: "详情", exact: true }).click();
  await expect(card.locator(".package-details dd").first()).toHaveText("未知");
  const older = { ...manifest, identity: { ...manifest.identity, version: "0.9.0" } };
  await page.locator("[data-import-file]").setInputFiles({ name: "older.hocpkg", mimeType: "application/zip",
    buffer: Buffer.from(zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(older)), "resources/data.json": body })) });
  await expect(page.locator("[data-import-dialog]")).toContainText("v1.0.0 → v0.9.0 · 降级");
  await expect(page.locator("[data-import-candidate]")).not.toBeChecked();
  await page.locator("[data-import-candidate]").check();
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await expect(card).toContainText("v0.9.0");
  await card.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator("[data-game-dialog]")).toContainText("删除内容包 e2e/test-plugin");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await expect(card.locator("[data-export-package]")).toHaveCount(1);
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await card.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.locator("[data-game-dialog-choice]")).toHaveCount(1);
  await expect(page.locator("[data-game-dialog]")).toContainText("e2e/test-plugin");
  await page.locator("[data-game-dialog-close]").click();
  expect(downloads).toBe(0);
  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: "导出", exact: true }).click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 hocpkg 包" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("e2e-test-plugin.hocpkg");
  const cover = readFileSync(new URL("../../public/assets/package-cover-fallback.png", import.meta.url));
  const matchBody = Buffer.from(JSON.stringify({ definition: { assets: { cover: "cover.png" } } }));
  const characterManifest = {
    ...manifest,
    identity: { authorId: "e2e", packageName: "test-character", version: "1.0.0" },
    metadata: { ...manifest.metadata, title: "测试角色包", license: "" },
    resources: [{ id: "match", type: "game.character-match", apiVersion: 3, entry: "resources/match.json", requires: [] }],
    files: [
      { path: "resources/match.json", bytes: matchBody.length, sha256: createHash("sha256").update(matchBody).digest("hex"), mediaType: "application/json" },
      { path: "cover.png", bytes: cover.length, sha256: createHash("sha256").update(cover).digest("hex"), mediaType: "image/png" }
    ]
  };
  await page.locator("[data-import-file]").setInputFiles({ name: "character.hocpkg", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(characterManifest)), "resources/match.json": matchBody, "cover.png": cover })) });
  await expect(page.locator("[data-import-dialog]")).toContainText("e2e/test-character");
  await page.locator("[data-import-next]").click();
  const character = page.locator('.package-card[data-package-id="e2e/test-character"]');
  await character.getByRole("button", { name: "详情", exact: true }).click();
  await expect(character.locator(".package-details dd").first()).toHaveText("未知");
  await character.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.locator("[data-game-dialog-choice]")).toHaveCount(2);
  await expect(page.locator("[data-game-dialog]")).toContainText("测试角色包 · e2e/test-character");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    expect(await page.locator("[data-game-dialog]").evaluate((dialog) => {
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  const pngDownloadPromise = page.waitForEvent("download");
  await character.getByRole("button", { name: "导出", exact: true }).click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出封面 PNG" }).click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toBe("e2e-test-character.png");
  expect(readFileSync((await pngDownload.path())!).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(nativeDialogs).toBe(0);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const version = await (await root.getDirectoryHandle("content")).getDirectoryHandle("v1");
    const revisions = await version.getDirectoryHandle("revisions");
    const author = await revisions.getDirectoryHandle("e2e");
    const pkg = await author.getDirectoryHandle("test-plugin");
    const names: string[] = [];
    for await (const key of pkg.keys()) names.push(key);
    return names.length;
  })).toBe(1);
});
