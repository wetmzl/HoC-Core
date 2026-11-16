import { expect, test, type Page } from "@playwright/test";
import type { LongTermSave } from "../../src/persistence/schema";

async function watchStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { databaseOpens: 0, contentOpens: 0 };
    (window as unknown as { __sessionStorageProbe: typeof probe }).__sessionStorageProbe = probe;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<IDBFactory["open"]>) => { probe.databaseOpens++; return open(...args); };
    const getDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = () => { probe.contentOpens++; return getDirectory(); };
  });
}

async function expectUntouchedStorage(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as {
    __sessionStorageProbe: { databaseOpens: number; contentOpens: number };
  }).__sessionStorageProbe)).toEqual({ databaseOpens: 0, contentOpens: 0 });
}

async function expectBlocked(page: Page, title = "游戏已在其他页面打开"): Promise<void> {
  await expect(page.locator("[data-browser-session-blocked]")).toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新尝试", exact: true })).toBeEnabled();
  await expect(page.locator("[data-start-game], [data-open-packages]")).toHaveCount(0);
  await expectUntouchedStorage(page);
}

async function enterGame(page: Page): Promise<void> {
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async warning => {
    await warning.locator("[data-acknowledge-adult-content]").click();
  });
  await page.addLocatorHandler(page.locator("#tutorial-popover"), async tutorial => {
    await tutorial.getByRole("button", { name: "跳过", exact: true }).click();
  }, { noWaitAfter: true });
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
}

async function readSave(page: Page): Promise<LongTermSave> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("house-of-chances");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<LongTermSave>((resolve, reject) => {
        const request = db.transaction("saves", "readonly").objectStore("saves").get("long-term");
        request.onsuccess = () => resolve(request.result.data as LongTermSave);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

test("第二页不接触存储，原页面关闭后重试读取新进度且设置保存不会回退", async ({ page, context }, info) => {
  await page.goto("/");
  await enterGame(page);
  const initial = await readSave(page);
  const imported = { ...initial, profile: { ...initial.profile, displayName: "会话回归进度", matchesPlayed: 17, wins: 5 } };
  await page.locator('[data-open="settings"]').click();
  await page.locator("#save-file").setInputFiles({
    name: "session-progress.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported))
  });
  await expect(page.locator("#settings")).not.toBeVisible();
  const beforeOtherPage = await readSave(page);
  expect(beforeOtherPage.profile).toEqual(imported.profile);
  // A second initialization used to remove in-flight import directories as well.
  await page.evaluate(async () => {
    const content = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("content")).getDirectoryHandle("v1");
    for (const name of ["imports", "import-inputs"]) {
      const directory = await content.getDirectoryHandle(name, { create: true });
      const output = await (await directory.getFileHandle("session-probe.txt", { create: true })).createWritable();
      await output.write("保留当前页面的导入文件"); await output.close();
    }
  });
  const other = await context.newPage();
  await watchStorage(other);
  await other.goto("/");
  await expectBlocked(other);
  expect(await readSave(page)).toEqual(beforeOtherPage);
  expect(await page.evaluate(async () => {
    const content = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("content")).getDirectoryHandle("v1");
    return Promise.all(["imports", "import-inputs"].map(async name => {
      const file = await (await content.getDirectoryHandle(name)).getFileHandle("session-probe.txt");
      return (await file.getFile()).text();
    }));
  })).toEqual(["保留当前页面的导入文件", "保留当前页面的导入文件"]);
  await other.screenshot({ path: info.outputPath("second-page-blocked-390.png") });
  await page.close();
  await other.getByRole("button", { name: "重新尝试", exact: true }).click();
  await expect(other.locator("[data-start-game]")).toBeEnabled();
  await enterGame(other);
  expect((await readSave(other)).profile).toEqual(imported.profile);
  await other.locator('[data-open="settings"]').click();
  await other.locator('[data-setting="reducedMotion"]').setChecked(!imported.settings.reducedMotion);
  await expect(other.locator("#lobby-status")).toHaveText("设置已保存。");
  const saved = await readSave(other);
  expect(saved.profile).toEqual(imported.profile);
  expect(saved.settings.reducedMotion).toBe(!imported.settings.reducedMotion);
});

test("同时首次打开只有一页初始化，另一页不读取或改写本地数据", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([watchStorage(page), watchStorage(other)]);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect.poll(async () => Promise.all([page, other].map(candidate => candidate.locator("[data-browser-session-blocked]").count())))
    .toContain(1);
  const blocked = await page.locator("[data-browser-session-blocked]").count() ? page : other;
  const active = blocked === page ? other : page;
  await expectBlocked(blocked);
  await expect(active.locator("[data-start-game]")).toBeEnabled();
  await expect(active.locator("[data-browser-session-blocked]")).toHaveCount(0);
});

test("返回启动器、切换页面和刷新都保持单一可写页面", async ({ page, context }) => {
  await page.goto("/");
  await enterGame(page);
  const other = await context.newPage();
  await watchStorage(other);
  await other.goto("/");
  await expectBlocked(other);
  await page.bringToFront();
  await page.getByRole("button", { name: "返回启动器", exact: true }).click();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await other.bringToFront();
  await other.getByRole("button", { name: "重新尝试", exact: true }).click();
  await expectBlocked(other);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await other.getByRole("button", { name: "重新尝试", exact: true }).click();
  await expectBlocked(other);
});

for (const failure of ["unavailable", "rejected"] as const) {
  test(`会话锁${failure === "unavailable" ? "不可用" : "请求失败"}时阻止启动并保留存储`, async ({ page }) => {
    await watchStorage(page);
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, "locks", { configurable: true, value: mode === "unavailable" ? undefined : {
        request: () => Promise.reject(new DOMException("会话锁被拒绝", "SecurityError"))
      } });
    }, failure);
    await page.goto("/");
    await expectBlocked(page, "暂时无法打开游戏");
    await page.getByRole("button", { name: "重新尝试", exact: true }).click();
    await expectBlocked(page, "暂时无法打开游戏");
  });
}
