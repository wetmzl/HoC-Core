import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

for (const failure of ["cycle", "unsupported-api", "invalid-json"] as const) {
  test(`完整的 ${failure} 包可以安装并重载，只在启动时校验`, async ({ page }) => {
    const body = Buffer.from(failure === "invalid-json" ? "{invalid JSON" : "{}");
    const manifest = {
      format: "house-of-chances-hocpkg", formatVersion: 1,
      identity: { authorId: "test", packageName: "deferred", version: "1.0.0" },
      metadata: { title: "延迟校验测试", description: "完整但无法运行的中性测试包", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
      resources: [{ id: "skill", type: "game.player-skill", apiVersion: failure === "unsupported-api" ? 999 : 4, entry: "skill.json", requires: failure === "cycle" ? ["skill"] : [] }],
      files: [{ path: "skill.json", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "application/json" }],
      extensions: {}
    };

    await page.goto("/");
    await page.getByRole("button", { name: "资源管理", exact: true }).click();
    await page.locator("[data-import-file]").setInputFiles({ name: "complete.hocpkg", mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), "skill.json": body })) });
    await page.getByRole("button", { name: "安装所选包" }).click();
    const card = page.locator('.package-card[data-package-id="test/deferred"]');
    await expect(card).toBeVisible();
    await expect(card.locator(".package-error")).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "资源管理", exact: true }).click();
    await expect(card).toBeVisible();
    await expect(card.locator(".package-error")).toHaveCount(0);
    await card.getByRole("button", { name: "启用", exact: true }).click();
    await respondToOfficialPlaylistCopy(page, "confirm");
    await page.getByRole("button", { name: "关闭资源管理" }).click();
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    if (failure !== "cycle") {
      await expect(page.locator("#third-party-content-warning")).toBeVisible();
      await page.locator("[data-acknowledge-third-party-content]").click();
    }
    const dialog = page.locator("[data-startup-error]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("pre")).toBeHidden();
    await expect(dialog.locator("summary")).toHaveText("详细报错");
    await expect(dialog.locator(".startup-error-details p")).toHaveCount(0);
    await expect(dialog.locator("[data-startup-error-reason]")).toContainText(failure === "cycle" ? "互相卡住" : failure === "unsupported-api" ? "更新" : "读不懂");
    await expect(page.locator("[data-launcher-status]")).not.toContainText("test/deferred");
    await dialog.locator("summary").click();
    await expect(dialog.locator("pre")).toContainText("test/deferred");
    if (failure === "cycle") {
      await dialog.getByRole("button", { name: "禁用相关内容并重试", exact: true }).click();
      await page.getByRole("button", { name: "我已成年并继续" }).click();
      await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
      return;
    }
    await dialog.getByRole("button", { name: "返回启动器", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "资源管理", exact: true })).toBeEnabled();
  });
}
