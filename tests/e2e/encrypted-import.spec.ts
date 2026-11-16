import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { encryptedZip, neutralPackage, nestedFixture } from "../fixtures/encrypted-bundles";

async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 180_000 });
  await page.locator("[data-open-packages]").click();
}
async function book(page: Page, passwords: string[]) {
  await page.locator("[data-password-book]").click();
  const dialog = page.getByRole("dialog", { name: "密码本", exact: true });
  for (const password of passwords) { await dialog.locator('[name="password"]').fill(password); await dialog.getByRole("button", { name: "添加", exact: true }).click(); }
  await dialog.getByRole("button", { name: "关闭密码本" }).click();
}
async function upload(page: Page, bytes: Uint8Array, playlist = false) {
  if (playlist) await page.locator("[data-open-playlist-import]").click();
  await page.locator(playlist ? "[data-playlist-file]" : "[data-import-file]").setInputFiles({ name: "encrypted.dat", mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  if (playlist) await page.locator('[data-game-dialog-choice="yes"]').click();
}
const prompt = (page: Page) => page.getByRole("dialog", { name: "解锁加密 ZIP", exact: true });

test("密码本自动解锁所有层级，改后缀的文件可直接导入", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page); await book(page, ["wrong", "outer-key", "book-key", "manual-key", "unknown-a", "unknown-b"]);
  await upload(page, await nestedFixture());
  await expect(page.locator("[data-import-candidate]")).toHaveCount(5);
  await expect(prompt(page)).toHaveCount(0);
  await expect(page.locator("[data-import-dialog] .package-error")).toHaveCount(0);
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await expect(page.locator('.package-card[data-package-id^="zip-test/"]')).toHaveCount(5);
});

test("部分密码未知：手动输错重试、保存成功密码、跳过两个分支，其余可安装并保留", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page); await book(page, ["wrong", "outer-key", "book-key"]);
  await upload(page, await nestedFixture());
  await expect(prompt(page).locator("[data-password-source]")).toContainText("manual.zip");
  await prompt(page).locator('[name="password"]').fill("bad-manual");
  await prompt(page).getByRole("button", { name: "解锁", exact: true }).click();
  // The closing attempt already has the failure text; wait for its empty retry field.
  await expect(prompt(page).locator('[name="password"]')).toHaveValue("");
  await expect(prompt(page)).toContainText("已有密码均未能解锁");
  await prompt(page).locator('[name="password"]').fill("manual-key");
  await prompt(page).locator('[name="remember"]').check();
  await prompt(page).getByRole("button", { name: "解锁", exact: true }).click();
  for (const name of ["missing-a.zip", "missing-b.zip"]) {
    await expect(prompt(page).locator("[data-password-source]")).toContainText(name);
    await prompt(page).getByRole("button", { name: "跳过此包", exact: true }).click();
  }
  await expect(page.locator("[data-import-candidate]")).toHaveCount(3);
  await expect(page.locator("[data-import-dialog] .package-error")).toHaveCount(2);
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await page.reload(); await page.locator("[data-open-packages]").click();
  await expect(page.locator('.package-card[data-package-id^="zip-test/"]')).toHaveCount(3);
  await page.locator("[data-password-book]").click();
  await expect(page.locator("[data-password-list] p")).toHaveCount(4);
  await page.getByRole("button", { name: "关闭密码本" }).click();
  // Remembered password is retried before prompting on the next import.
  await upload(page, await nestedFixture());
  await expect(prompt(page).locator("[data-password-source]")).toContainText("missing-a.zip");
  await prompt(page).getByRole("button", { name: "取消整个导入", exact: true }).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
});

test("等待密码时 Escape 取消，清理后可从播放集入口重试", async ({ page }) => {
  test.setTimeout(240_000);
  const bytes = await encryptedZip(unzipSync(neutralPackage("single")), "single-key");
  await open(page); await upload(page, bytes);
  await expect(prompt(page)).toBeVisible(); await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveCount(0);
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  await expect(page.locator('.package-card[data-package-id="zip-test/single"]')).toHaveCount(0);
  await upload(page, bytes, true);
  await prompt(page).locator('[name="password"]').fill("single-key");
  await prompt(page).getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.locator("[data-import-candidate]")).toHaveCount(1);
  await page.locator("[data-import-next]").click();
  await expect(page.locator('.package-card[data-package-id="zip-test/single"]')).toHaveCount(1);
  await page.locator("[data-password-book]").click();
  await expect(page.locator("[data-password-list]")).toHaveText("个人密码本为空。");
  await page.getByRole("button", { name: "关闭密码本" }).click();
  const leftovers = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const content = await (await root.getDirectoryHandle("content")).getDirectoryHandle("v1");
    const imports = await content.getDirectoryHandle("imports");
    return Array.fromAsync((imports as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys());
  });
  expect(leftovers).toEqual([]);
});

test("密码本添加去重、删除、清空及重载保留", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page); await book(page, [" one ", "two", "two"]);
  await page.reload(); await page.locator("[data-open-packages]").click();
  await page.locator("[data-password-book]").click();
  await expect(page.locator("[data-password-list] p")).toHaveCount(2);
  await page.getByRole("button", { name: "删除密码 1", exact: true }).click();
  await expect(page.locator("[data-password-list] p")).toHaveCount(1);
  await page.getByRole("button", { name: "清空密码本", exact: true }).click();
  await expect(page.locator("[data-password-list]")).toHaveText("个人密码本为空。");
});


test("内置 welcome2hoc 对新安装、旧个人密码本和清空后都自动生效", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const bytes = await encryptedZip({ "builtin.hocpkg": neutralPackage("builtin") }, "welcome2hoc");
  for (const personal of [[], ["existing-personal-password"], ["welcome2hoc"]]) {
    await page.evaluate(values => {
      if (values.length) localStorage.setItem("hoc.import-passwords.v1", JSON.stringify(values));
      else localStorage.removeItem("hoc.import-passwords.v1");
    }, personal);
    await upload(page, bytes);
    await expect(page.locator("[data-import-candidate]")).toHaveCount(1);
    await expect(prompt(page)).toHaveCount(0);
    await page.locator("[data-import-cancel]").click();
    await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hoc.import-passwords.v1") ?? "[]"))).toEqual(personal);
  }
  await page.locator("[data-password-book]").click();
  await expect(page.locator("[data-builtin-passwords]")).toHaveCount(0);
  await page.getByRole("button", { name: "清空密码本", exact: true }).click();
  await expect(page.locator("[data-builtin-passwords]")).toHaveCount(0);
  await expect(page.locator("[data-password-list]")).toHaveText("个人密码本为空。");
  await page.getByRole("button", { name: "关闭密码本" }).click();
  await upload(page, bytes);
  await expect(page.locator("[data-import-candidate]")).toHaveCount(1);
  await expect(prompt(page)).toHaveCount(0);
  await page.locator("[data-import-next]").click();
  await expect(page.locator('.package-card[data-package-id="zip-test/builtin"]')).toHaveCount(1);
});
