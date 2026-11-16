import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { embedHocpkgInPng, extractHocpkgFromPng } from "../../src/content/transfer/hocpkg";
import { playlistDocument } from "../../src/content/playlists/store";
import { encodePlaylistHocpkg } from "../../src/content/playlists/transfer";
import { playlistCoverDataUrl } from "../../src/content/playlists/cover";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

test("播放集封面仅在导入预览显示，列表和管理隐藏，PNG 导出保留", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const cover = readFileSync(new URL("../../public/assets/playlist-cover.png", import.meta.url));
  const document = playlistDocument("封面测试", [{ packageId: "hoc-core/chatgpt" }], [], "replace", playlistCoverDataUrl(cover));
  const archive = await encodePlaylistHocpkg(document, crypto.randomUUID());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "cover.hocpkg", mimeType: "application/zip", buffer: Buffer.from(archive) });
  const importCover = page.locator(".import-candidate-card img");
  await expect(importCover).toBeVisible();
  await expect.poll(() => importCover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
  const previewDigest = await importCover.evaluate(async (image: HTMLImageElement) => {
    const bytes = await (await fetch(image.src)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  });
  expect(previewDigest).toBe(createHash("sha256").update(cover).digest("hex"));
  await page.locator("[data-import-next]").click();
  await page.locator("[data-import-activate]").click();
  await expect(page.locator(".playlist-current-name")).toHaveText("封面测试");
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-toggle-playlist-menu]").click();
  await expect(page.locator(".playlist-menu img")).toHaveCount(0);
  await page.locator("[data-toggle-playlist-menu]").click();
  await page.locator("[data-open-playlist-manager]").click();
  const row = page.locator('[data-manage-playlist]:has(input[value="封面测试"])');
  await expect(row.locator("img")).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  const downloadPromise = page.waitForEvent("download");
  await row.locator("[data-export-playlist]").click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 PNG" }).click();
  const png = readFileSync((await (await downloadPromise).path())!);
  const payload = extractHocpkgFromPng(png);
  expect(png).toEqual(Buffer.from(embedHocpkgInPng(cover, payload)));
  expect(Buffer.from(unzipSync(payload)["cover.png"]!)).toEqual(cover);
});

test("播放集始终保存，导入后切换并在重启后恢复", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
  await expect(page.locator("[data-playlist-name], [data-save-playlist]")).toHaveCount(0);
  await page.locator("[data-open-playlist-manager]").click();
  const manager = page.locator("[data-playlist-manager]");
  await expect(manager.locator("[data-manage-playlist]")).toHaveCount(1);
  await manager.locator("[data-copy-playlist]").click();
  await expect(manager.locator("[data-manage-playlist]")).toHaveCount(2);
  await manager.locator("[data-playlist-rename-input]").last().fill("夜场");
  await manager.locator("[data-playlist-rename-input]").last().press("Enter");
  await expect(manager.locator("[data-playlist-rename-input]").last()).toHaveValue("夜场");
  const downloadPromise = page.waitForEvent("download");
  await manager.locator('[data-manage-playlist]:has(input[value="夜场"]) [data-export-playlist]').click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 hocpkg" }).click();
  const download = await downloadPromise;
  const files = unzipSync(readFileSync((await download.path())!));
  expect(JSON.parse(Buffer.from(files["playlist.json"]!).toString())).toMatchObject({ formatVersion: 2, pluginOrder: ["hoc-core/character-tap", "hoc-core/debug-engine"] });
  const pngDownloadPromise = page.waitForEvent("download");
  await manager.locator('[data-manage-playlist]:has(input[value="夜场"]) [data-export-playlist]').click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 PNG" }).click();
  const pngDownload = await pngDownloadPromise;
  const png = readFileSync((await pngDownload.path())!);
  const payload = extractHocpkgFromPng(png);
  const cover = readFileSync(new URL("../../public/assets/playlist-cover.png", import.meta.url));
  expect(png).toEqual(Buffer.from(embedHocpkgInPng(cover, payload)));
  expect(JSON.parse(Buffer.from(unzipSync(payload)["playlist.json"]!).toString())).toMatchObject({ name: "夜场", formatVersion: 2, pluginOrder: ["hoc-core/character-tap", "hoc-core/debug-engine"] });
  await page.locator("[data-close-playlist-manager]").click();
  await page.locator("[data-open-playlist-import]").click();
  await page.locator("[data-playlist-file]").setInputFiles({ name: "playlist.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".playlist-current-name")).toHaveText("夜场（副本 1）");
  await expect(page.locator("[data-playlist-import]")).not.toBeVisible();

  await page.locator("[data-open-playlist-import]").click();
  await page.locator("[data-playlist-paste]").fill(JSON.stringify({ format: "house-of-chances-playlist", formatVersion: 1, name: "缺席者", packages: [{ packageId: "missing/hero", version: "1.0.0" }] }));
  await page.locator("[data-import-playlist-text]").click();
  await expect(page.locator(".playlist-current-name")).toHaveText("缺席者");
  await expect(page.locator(".playlist-status")).toContainText("缺失：missing/hero");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator(".playlist-current-name")).toHaveText("缺席者");
  await page.locator("[data-open-playlist-manager]").click();
  await manager.locator('[data-manage-playlist]:has(input[value="缺席者"]) [data-delete-playlist]').click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".playlist-status")).toContainText("当前播放集不能删除");
  await page.locator("[data-close-playlist-manager]").click();
  await page.locator("[data-toggle-playlist-menu]").click();
  await page.locator(".playlist-menu").getByRole("button", { name: /^夜场 / }).click();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});


test("增量集导入保留其他包，编辑导出与重启后保留类型和成员", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  const card = (id: string) => page.locator(`.package-card[data-package-id="hoc-core/${id}"]`);
  await card("claude").locator('[data-package-action="disable"]').click();
  await respondToOfficialPlaylistCopy(page, "confirm");
  await expect(card("claude")).toHaveAttribute("data-package-state", "disabled");
  await card("deepseek").locator('[data-package-action="disable"]').click();
  await expect(card("deepseek")).toHaveAttribute("data-package-state", "disabled");
  await page.locator("[data-open-playlist-import]").click();
  await page.locator("[data-playlist-paste]").fill(JSON.stringify({
    format: "house-of-chances-playlist", formatVersion: 2, name: "增量测试", mode: "incremental",
    packages: [{ packageId: "hoc-core/claude" }, { packageId: "missing/hero" }], pluginOrder: []
  }));
  await page.locator("[data-import-playlist-text]").click();
  await expect(page.locator(".playlist-current-name")).toHaveText("增量测试（增量）");
  await expect(card("claude")).toHaveAttribute("data-package-state", "enabled");
  await expect(card("chatgpt")).toHaveAttribute("data-package-state", "enabled");
  await expect(card("deepseek")).toHaveAttribute("data-package-state", "disabled");
  await expect(page.locator(".playlist-status")).toContainText("missing/hero");
  await card("deepseek").locator('[data-package-action="enable"]').click();
  await expect(card("deepseek")).toHaveAttribute("data-package-state", "enabled");
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator(".playlist-current-name")).toHaveText("增量测试（增量）");
  await expect(card("chatgpt")).toHaveAttribute("data-package-state", "enabled");
  await page.locator("[data-open-playlist-manager]").click();
  const manager = page.locator("[data-playlist-manager]");
  const row = manager.locator('[data-manage-playlist]:has(input[value="增量测试"])');
  await expect(manager.locator("[data-playlist-mode], [data-create-incremental-playlist]")).toHaveCount(0);
  await row.locator("[data-export-playlist]").click();
  await expect(page.getByRole("checkbox", { name: /^作为增量集导出/ })).toBeChecked();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 hocpkg" }).click();
  const download = await downloadPromise;
  const files = unzipSync(readFileSync((await download.path())!));
  const exported = JSON.parse(Buffer.from(files["playlist.json"]!).toString());
  expect(exported.mode).toBe("incremental");
  expect(exported.name).toBe("增量测试");
  expect(exported.packages.map((entry: { packageId: string }) => entry.packageId).sort()).toEqual(["hoc-core/claude", "hoc-core/deepseek", "missing/hero"]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    expect(await manager.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await row.locator("[data-export-playlist]").click();
  await page.getByRole("checkbox", { name: /^作为增量集导出/ }).uncheck();
  const normalDownload = page.waitForEvent("download");
  await page.locator("[data-game-dialog]").getByRole("button", { name: "导出 hocpkg" }).click();
  const normal = unzipSync(readFileSync((await (await normalDownload).path())!));
  expect(JSON.parse(Buffer.from(normal["playlist.json"]!).toString()).mode).toBeUndefined();
  await row.locator("[data-export-playlist]").click();
  await expect(page.getByRole("checkbox", { name: /^作为增量集导出/ })).toBeChecked();
  await page.locator("[data-game-dialog-close]").click();
  await expect(page.locator(".playlist-current-name")).toHaveText("增量测试（增量）");
});


test("只在导出弹窗选择增量类型，三种格式不改写本机播放集", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  const before = await page.locator(".package-card").evaluateAll(cards => cards.map(card => [card.getAttribute("data-package-id"), card.getAttribute("data-package-state")]));
  await page.locator("[data-open-playlist-manager]").click();
  const manager = page.locator("[data-playlist-manager]");
  await expect(manager.locator("select, [data-create-incremental-playlist], .playlist-mode-help")).toHaveCount(0);
  for (const format of ["hocpkg", "PNG", "JSON"]) {
    await manager.locator("[data-export-playlist]").click();
    const toggle = page.getByRole("checkbox", { name: /^作为增量集导出/ });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    if (format === "JSON") {
      await page.locator("[data-game-dialog]").getByRole("button", { name: "纯文本 JSON" }).click();
      await expect(page.locator("[data-playlist-text-dialog]")).toBeVisible();
      expect(JSON.parse(await page.locator("[data-playlist-export-text]").inputValue()).mode).toBe("incremental");
    }
    const downloadPromise = page.waitForEvent("download");
    if (format === "JSON") await page.locator("[data-download-playlist-text]").click();
    else await page.locator("[data-game-dialog]").getByRole("button", { name: `导出 ${format}` }).click();
    const bytes = readFileSync((await (await downloadPromise).path())!);
    const document = format === "JSON" ? JSON.parse(bytes.toString()) : JSON.parse(Buffer.from(unzipSync(format === "PNG" ? extractHocpkgFromPng(bytes) : bytes)["playlist.json"]!).toString());
    expect(document.mode).toBe("incremental");
    if (format === "JSON") await page.locator("[data-close-playlist-text]").click();
  }
  await manager.locator("[data-export-playlist]").click();
  await expect(page.getByRole("checkbox", { name: /^作为增量集导出/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /^作为增量集导出/ }).check();
  await page.locator("[data-game-dialog-close]").click();
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await manager.locator("[data-export-playlist]").click();
  await expect(page.getByRole("checkbox", { name: /^作为增量集导出/ })).not.toBeChecked();
  await page.locator("[data-game-dialog-close]").click();
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  expect(await page.locator(".package-card").evaluateAll(cards => cards.map(card => [card.getAttribute("data-package-id"), card.getAttribute("data-package-state")]))).toEqual(before);
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
});
