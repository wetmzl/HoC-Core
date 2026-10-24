import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

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
