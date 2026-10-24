import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";

const defaultCover = readFileSync(new URL("../../public/assets/save-share-cover.png", import.meta.url));
const pluginCover = readFileSync(new URL("../../public/assets/package-cover-fallback.png", import.meta.url));

async function exportImage(page: Page) {
  const download = page.waitForEvent("download");
  await page.locator("[data-export]").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("house-of-chances-save.png");
  const png = readFileSync((await file.path())!);
  const chunks = [png.subarray(0, 8)];
  let save: any;
  for (let offset = 8; offset < png.length;) {
    const end = offset + 12 + png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "svJS") {
      save = JSON.parse(png.toString("utf8", offset + 8, end - 4));
    } else chunks.push(png.subarray(offset, end));
    offset = end;
  }
  expect(save).toBeDefined();
  return { art: Buffer.concat(chunks), save };
}

async function startGame(page: Page, plugin = false) {
  await page.locator("[data-start-game]").click();
  if (plugin) await page.locator("[data-acknowledge-third-party-content]").click();
  await page.locator("[data-acknowledge-adult-content]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator('[data-open="settings"]').click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
});

test("base game always exports the fixed card regardless of defeat records", async ({ page }) => {
  await startGame(page);
  const initial = await exportImage(page);
  expect(initial.art.equals(defaultCover)).toBe(true);
  expect(initial.art.readUInt32BE(16)).toBe(1000);
  expect(initial.art.readUInt32BE(20)).toBe(1400);
  for (const opponentId of ["chatgpt", "claude", "uninstalled-character"]) {
    const defeats = [{ opponentId, timestamp: "2026-10-12T00:00:00.000Z" }];
    await page.locator("#save-file").setInputFiles({
      name: "save.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ ...initial.save, defeats }))
    });
    await expect(page.locator("#settings")).not.toBeVisible();
    await page.locator('[data-open="settings"]').click();
    const exported = await exportImage(page);
    expect(exported.art.equals(defaultCover)).toBe(true);
    expect(exported.save.defeats).toEqual(defeats);
  }
});

test("a loaded neutral plugin overrides the card and falls back when its cover is absent or fails", async ({ page }) => {
  // Vite serves the SPA shell for missing assets; simulate an actual failed image request.
  await page.route("**/assets/missing-plugin-cover.png", route => route.fulfill({ status: 404, body: "missing" }));
  const files = {
    "module.json": Buffer.from(JSON.stringify({ module: "module.js", style: "style.css", provides: [] })),
    "module.js": Buffer.from(`export async function register(host) {
      const cover = await host.resolveAsset("cover.png");
      return { handlers: [], createRuntime() { return {
        async saveCoverCandidates(save) {
          if (globalThis.__coverMode === "error") throw new Error("simulated plugin failure");
          if (globalThis.__coverMode === "empty") return [];
          if (globalThis.__coverMode === "missing") return ["/assets/missing-plugin-cover.png"];
          globalThis.__coverDefeats = save.defeats.length;
          return [cover];
        }
      }; } };
    }`),
    "style.css": Buffer.from("/* Neutral save-cover test plugin. */"),
    "cover.png": pluginCover
  };
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "save-cover", version: "1.0.0" },
    metadata: { title: "存档封面验证插件", description: "中性图片覆盖测试", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion: 2, entry: "module.json", requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: path.endsWith(".png") ? "image/png" : path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })),
    extensions: {}
  };
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "cover.hocpkg", mimeType: "application/zip",
    buffer: Buffer.from(zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), ...files })) });
  await page.locator("[data-import-next]").click();
  await page.locator('.package-card[data-package-id="example/save-cover"]').getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await startGame(page, true);
  expect((await exportImage(page)).art.equals(pluginCover)).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).__coverDefeats)).toBe(0);
  for (const mode of ["empty", "missing", "error"]) {
    await page.evaluate(mode => { (globalThis as any).__coverMode = mode; }, mode);
    expect((await exportImage(page)).art.equals(defaultCover)).toBe(true);
  }
});
