import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { embedHocpkgInPng } from "../../src/content/transfer/hocpkg";

function playlistHocpkg(name: string, packages: { packageId: string; version: string }[]) {
  const body = Buffer.from(JSON.stringify({ format: "house-of-chances-playlist", formatVersion: 1, name, packages }));
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "bundle", packageName: `playlist-${randomUUID()}`, version: "1.0.0" },
    metadata: { title: name, description: "E2E", tags: [], creators: [{ displayName: "E2E", roles: ["design"] }] },
    resources: [{ id: "playlist", type: "hoc.playlist", apiVersion: 1, entry: "playlist.json", requires: [] }],
    files: [{ path: "playlist.json", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "application/json" }],
    extensions: {}
  };
  return zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), "playlist.json": body });
}

function contentHocpkg() {
  const body = Buffer.from('{"bundle":true}');
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "bundle", packageName: "module", version: "1.0.0" },
    metadata: { title: "整合包资源测试：这是一个非常长的角色包名称，用来检查小屏幕预览卡片文字", description: "E2E", tags: [], creators: [{ displayName: "E2E", roles: ["design"] }] },
    resources: [{ id: "data", type: "test.data", apiVersion: 1, entry: "resources/data.json", requires: [] }],
    files: [{ path: "resources/data.json", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "application/json" }],
    extensions: {}
  };
  return zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), "resources/data.json": body });
}

test("播放集入口确认后复用整合包导入，拒绝和关闭不安装", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  await page.locator("[data-open-playlist-import]").click();
  const playlistDialog = page.locator("[data-playlist-import]");
  const prompt = page.locator("[data-game-dialog]");
  const importedPackage = page.locator('.package-card[data-package-id="bundle/module"]');
  await playlistDialog.locator("[data-playlist-file]").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("not json") });
  await expect(playlistDialog.locator("[data-playlist-import-status]")).not.toBeEmpty();
  await expect(prompt).toHaveCount(0);

  const bundle = Buffer.from(zipSync({
    "content.hocpkg": contentHocpkg(),
    "playlist.hocpkg": playlistHocpkg("导入引导测试", [{ packageId: "bundle/module", version: "1.0.0" }]),
    "unused.bin": new Uint8Array(2 * 1024 * 1024)
  }, { level: 0 }));
  expect(bundle.length).toBeGreaterThan(2 * 1024 * 1024);
  const file = { name: "bundle.zip", mimeType: "application/zip", buffer: bundle };
  const cover = readFileSync(new URL("../../public/assets/package-cover-fallback.png", import.meta.url));
  const carriers = [file,
    { name: "content.hocpkg", mimeType: "application/zip", buffer: Buffer.from(contentHocpkg()) },
    { name: "content.png", mimeType: "image/png", buffer: Buffer.from(embedHocpkgInPng(cover, contentHocpkg())) }
  ];
  for (const [index, carrier] of carriers.entries()) {
    await playlistDialog.locator("[data-playlist-file]").setInputFiles(carrier);
    await expect(prompt).toContainText("检测到您导入的内容不是播放集，但可能是一个整合包。是否要导入整合包");
    if (index === 0) await prompt.getByRole("button", { name: "否", exact: true }).click();
    else if (index === 1) await prompt.getByRole("button", { name: "关闭弹窗" }).click();
    else await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
    await expect(playlistDialog).toBeVisible();
    await expect(importedPackage).toHaveCount(0);
    await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
    await expect(page.locator(".playlist-current-name")).toHaveText("默认播放集");
  }
  await playlistDialog.locator("[data-playlist-file]").setInputFiles(file);
  await prompt.getByRole("button", { name: "是", exact: true }).click();
  await expect(playlistDialog).not.toBeVisible();
  const importer = page.locator("[data-import-dialog]");
  await expect(importer).toContainText("导入引导测试");
  await expect(importer.locator("[data-import-candidate]:checked")).toHaveCount(2);
  await expect(importedPackage).toHaveCount(0);
  await importer.locator("[data-import-next]").click();
  await expect(importer).toContainText("是否启用包中附带的播放集");
  await importer.locator("[data-import-activate]").click();
  await expect(importer).toHaveCount(0);
  await expect(importedPackage).toHaveAttribute("data-package-state", "enabled");
  await expect(page.locator(".playlist-current-name")).toHaveText("导入引导测试");
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator(".playlist-current-name")).toHaveText("导入引导测试");
  await expect(importedPackage).toHaveAttribute("data-package-state", "enabled");
});

test("整合包先确认选择，再保存并切换播放集", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("button", { name: "资源管理" }).click();
  const single = zipSync({
    "__MACOSX/中文目录/._content.hocpkg": Buffer.from("metadata"),
    "中文目录/cover.png": readFileSync(new URL("../../public/assets/package-cover-fallback.png", import.meta.url)),
    "中文目录/content.hocpkg": contentHocpkg(),
    "中文目录/broken.hocpkg": Buffer.from("damaged"),
    "中文目录/nested.zip": zipSync({ "choice.hocpkg": playlistHocpkg("作者推荐", [{ packageId: "bundle/module", version: "1.0.0" }]) })
  });
  await page.locator("[data-import-file]").setInputFiles({ name: "single.zip", mimeType: "application/zip", buffer: Buffer.from(single) });
  const dialog = page.locator("[data-import-dialog]");
  await expect(dialog).toContainText("作者推荐");
  await expect(dialog).toContainText("broken.hocpkg");
  await expect(dialog).not.toContainText("__MACOSX");
  await expect(page.locator('.package-card[data-package-id="bundle/module"]')).toHaveCount(0);
  await expect(dialog.locator("[data-import-candidate]:checked")).toHaveCount(2);
  await dialog.locator("[data-import-candidate]").first().uncheck();
  await expect(dialog.locator("[data-import-candidate]:checked")).toHaveCount(1);
  await expect(dialog.locator("[data-import-next]")).toHaveText("安装所选包（1）");
  await dialog.locator("[data-import-candidate]").first().check();
  await expect(dialog.locator("[data-import-candidate]:checked")).toHaveCount(2);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    expect(await dialog.evaluate((node) => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.locator(".import-candidate-card").first().evaluate((card) => card.scrollWidth <= card.clientWidth + 1)).toBe(true);
  }
  await page.locator("[data-import-next]").click();
  await expect(dialog).toContainText("是否启用包中附带的播放集");
  await expect(page.locator('.package-card[data-package-id="bundle/module"]')).toHaveCount(0);
  await page.locator("[data-import-skip-playlist]").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.package-card[data-package-id="bundle/module"]')).toHaveAttribute("data-package-state", "disabled");
  await expect(page.locator(".playlist-current-name")).toHaveText("默认播放集");
  await page.locator("[data-toggle-playlist-menu]").click();
  await expect(page.locator(".playlist-menu")).toContainText("作者推荐");
  await page.locator("[data-toggle-playlist-menu]").click();

  const multiple = zipSync({ "a.hocpkg": playlistHocpkg("作者推荐", []), "b.hocpkg": playlistHocpkg("另一套", [{ packageId: "bundle/module", version: "1.0.0" }]) });
  await page.locator("[data-import-file]").setInputFiles({ name: "multiple.zip", mimeType: "application/zip", buffer: Buffer.from(multiple) });
  await expect(dialog.locator("[data-import-candidate]:checked")).toHaveCount(2);
  await page.locator("[data-import-next]").click();
  await page.locator("[data-import-playlist-choice]").selectOption({ label: "另一套" });
  await page.locator("[data-import-activate]").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".playlist-current-name")).toHaveText("另一套");
  await expect(page.locator('.package-card[data-package-id="bundle/module"]')).toHaveAttribute("data-package-state", "enabled");
  await page.reload();
  await page.getByRole("button", { name: "资源管理" }).click();
  await expect(page.locator(".playlist-current-name")).toHaveText("另一套");
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await page.locator("[data-toggle-playlist-menu]").click();
  await expect(page.locator(".playlist-menu")).toContainText("作者推荐（副本 1）");
});

test("受管文件选择器覆盖两个入口、入口转换和临时输入清理", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const paths = ["/src/application-controller.ts", "/src/launcher.ts", "/src/content/storage/memory-host.ts", "/src/content/storage/browser-io.ts"];
    const [{ ApplicationController }, { LauncherView }, { MemoryContentHostProvider }, { openBrowserArchive }] = await Promise.all(paths.map(path => import(path)));
    const provider = new MemoryContentHostProvider();
    const fs = provider.fileSystem;
    const state = { payload: "", picks: 0, archiveSources: [] as string[], readLengths: [] as number[], fs };
    fs.pickFile = async () => {
      state.picks++;
      const bytes = Uint8Array.from(atob(state.payload), character => character.charCodeAt(0));
      const path = `content/v1/import-inputs/${crypto.randomUUID()}.input`;
      await fs.write(path, bytes);
      return { name: "selected.input", size: bytes.length, source: { kind: "stored", path } };
    };
    fs.readRange = async (source: { kind: string; path: string }, offset: number, length: number) => {
      if (source.kind !== "stored") throw new Error("native reads require managed files");
      state.readLengths.push(length);
      return fs.entries.get(source.path).slice(offset, offset + length);
    };
    fs.openArchive = async (source: { kind: string; path: string }, options: unknown) => {
      if (source.kind !== "stored") throw new Error("native archives require managed files");
      state.archiveSources.push(source.kind);
      return openBrowserArchive(fs, source, options);
    };
    const controller = new ApplicationController({ providers: [provider] });
    await controller.initialize();
    const root = document.createElement("div");
    root.id = "app";
    document.body.replaceChildren(root);
    await new LauncherView(root, controller).mount();
    Reflect.set(window, "nativeImportTest", state);
  });
  const bundle = Buffer.from(zipSync({ "content.hocpkg": contentHocpkg(), "playlist.hocpkg": playlistHocpkg("受管文件播放集", []), "unused.bin": new Uint8Array(2 * 1024 * 1024) }, { level: 0 }));
  const select = async (payload: Buffer) => page.evaluate(value => { Reflect.get(window, "nativeImportTest").payload = value; }, payload.toString("base64"));
  const temporaryCount = () => page.evaluate(() => [...Reflect.get(window, "nativeImportTest").fs.entries.keys()].filter((key: string) => key.startsWith("content/v1/import-inputs/")).length);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator("[data-open-playlist-import]").click();
  await select(bundle);
  await page.getByText("选择 JSON、hocpkg、PNG 或 ZIP", { exact: true }).click();
  const prompt = page.locator("[data-game-dialog]");
  await expect(prompt).toContainText("是否要导入整合包");
  expect(await temporaryCount()).toBe(1);
  await prompt.getByRole("button", { name: "否", exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(temporaryCount).toBe(0);
  await page.getByText("选择 JSON、hocpkg、PNG 或 ZIP", { exact: true }).click();
  await prompt.getByRole("button", { name: "是", exact: true }).click();
  const importer = page.locator("[data-import-dialog]");
  await expect(importer.locator("[data-import-candidate]:checked")).toHaveCount(2);
  await expect.poll(temporaryCount).toBe(0);
  const titles = await importer.locator(".import-candidate-card h3").allTextContents();
  await importer.locator("[data-import-cancel]").click();
  await expect(importer).toHaveCount(0);
  await page.getByText("导入资源/资源包", { exact: true }).click();
  await expect(importer.locator("[data-import-candidate]:checked")).toHaveCount(2);
  expect(await importer.locator(".import-candidate-card h3").allTextContents()).toEqual(titles);
  await importer.locator("[data-import-cancel]").click();
  await select(Buffer.from(JSON.stringify({ format: "house-of-chances-playlist", formatVersion: 2, name: "原生 JSON", packages: [], pluginOrder: [] })));
  await page.locator("[data-open-playlist-import]").click();
  await page.getByText("选择 JSON、hocpkg、PNG 或 ZIP", { exact: true }).click();
  await expect(page.locator(".playlist-current-name")).toHaveText("原生 JSON");
  await expect.poll(temporaryCount).toBe(0);
  const evidence = await page.evaluate(() => {
    const { picks, archiveSources, readLengths } = Reflect.get(window, "nativeImportTest");
    return { picks, archiveSources, readLengths };
  });
  expect(evidence.picks).toBe(4);
  expect(evidence.archiveSources.every((source: string) => source === "stored")).toBe(true);
  expect(evidence.readLengths.slice(0, 2)).toEqual([8, 8]);
});
