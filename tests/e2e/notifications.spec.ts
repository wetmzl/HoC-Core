import { expect, test, type Page } from "@playwright/test";

async function mountNotifications(page: Page): Promise<void> {
  await page.route("/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>' }));
  await page.goto("/");
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/styles.css");
    await load("/src/table-screen-module.ts");
    const { NotificationController } = await load("/src/presentation/notification-controller.ts");
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const root = document.querySelector<HTMLDivElement>("#app")!;
    root.innerHTML = '<aside class="table-dashboard" style="position:absolute;top:80px;right:10px"><div class="roulette-status" style="height:48px"></div><div class="shoe-status" style="height:30px"></div><div class="display-panel" style="height:240px"></div></aside>';
    (window as any).testNotifications = new NotificationController({ root, save: createDefaultSave(), currentCharacter: { name: "对手" }, offerTutorial: () => {} });
  });
  await page.clock.install();
}

for (const width of [390, 320]) {
  test(`横幅最多三条且不超出手机宽度 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mountNotifications(page);
    await page.evaluate(() => {
      (window as any).testNotifications.enqueueAbilityNotices([
        { owner: "player", tone: "player", text: "策展人 · 示例技能：获得2点点数优势" },
        { owner: "opponent", tone: "ai", text: "对手 · 示例技能：本轮公共爆牌上限提高至22点" },
        { owner: "system", tone: "notification", text: "技能被禁用" },
        { owner: "system", tone: "notification", text: "全屏请求未获允许。" }
      ]);
    });
    await expect(page.locator(".ability-notice")).toHaveText(["全屏请求未获允许。", "技能被禁用", "对手 · 示例技能：本轮公共爆牌上限提高至22点"]);
    const bounds = await page.locator("#ability-notices").boundingBox();
    const dashboard = await page.locator(".table-dashboard").boundingBox();
    expect(bounds!.y).toBeCloseTo(dashboard!.y, 0);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.clock.runFor(2800);
    await expect(page.locator(".ability-notice")).toHaveCount(0);
  });
}

test("通知始终从状态栏顶部起排，不随读数增多下移，且跟随窗口调整", async ({ page }) => {
  await mountNotifications(page);
  await page.evaluate(() => (window as any).testNotifications.enqueueNotification("技能被禁用"));
  for (const height of [0, 48, 300]) {
    await page.locator(".display-panel").evaluate((node, value) => { (node as HTMLElement).style.height = `${value}px`; }, height);
    await page.evaluate(() => (window as any).testNotifications.syncAbilityNoticePosition());
    expect((await page.locator("#ability-notices").boundingBox())!.y).toBeCloseTo(80, 0);
  }
  await page.evaluate(() => {
    (document.querySelector(".table-dashboard") as HTMLElement).style.top = "100px";
    (window as any).testNotifications.attachAbilityNoticePositionListener();
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await expect.poll(async () => (await page.locator("#ability-notices").boundingBox())!.y).toBeCloseTo(100, 0);
});

test("重复提示复用原横幅、续期并能从渐隐恢复", async ({ page }) => {
  await mountNotifications(page);
  const enqueue = () => page.evaluate(() => (window as any).testNotifications.enqueueNotification("技能被禁用"));
  await enqueue();
  await page.clock.runFor(2000);
  await enqueue();
  await page.clock.runFor(600);
  await expect(page.locator(".ability-notice:not(.leaving)")).toHaveCount(1);
  await page.clock.runFor(1900);
  await expect(page.locator(".ability-notice.leaving")).toHaveCount(1);
  await enqueue();
  await page.clock.runFor(300);
  await expect(page.locator(".ability-notice:not(.leaving)")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).testNotifications.abilityNoticeTimers.size)).toBe(1);
  await page.evaluate(() => (window as any).testNotifications.dispose());
  await page.clock.runFor(3000);
  await expect(page.locator(".ability-notice")).toHaveCount(0);
});

test("实际重复发动的技能仍各自反馈，避免掩盖叠加效果", async ({ page }) => {
  await mountNotifications(page);
  await page.evaluate(() => {
    const notice = { owner: "player", tone: "player", text: "策展人 · 示例技能：获得2点点数优势" };
    (window as any).testNotifications.enqueueAbilityNotices([notice, notice]);
  });
  await expect(page.locator(".ability-notice-player")).toHaveCount(2);
});
