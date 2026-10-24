import { expect, test, type Page } from "@playwright/test";

const pluginCards = '[data-package-group="plugins"] .package-group-items > .package-card';
async function open(page: Page, extra = 0): Promise<string[]> {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  if (extra) {
    await page.evaluate(async count => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const { createDefaultContentHostProviders } = await load("/src/content/storage/host-factory.ts");
      const { resolveContentHost } = await load("/src/content/storage/contracts.ts");
      const { FileContentRepository } = await load("/src/content/storage/repository.ts");
      const { sha256 } = await load("/src/content/storage/encoding.ts");
      const { PLUGIN_MODULE_API_VERSION } = await load("/src/content/packages/plugin-version.ts");
      const repo = new FileContentRepository(await resolveContentHost(createDefaultContentHostProviders()));
      const bytes = new TextEncoder().encode(JSON.stringify({ module: "plugin.js", provides: [] }));
      const module = new TextEncoder().encode("export function register() { return { handlers: [], createRuntime() { return {}; } }; }");
      for (let i = 0; i < count; i++) {
        const files = [{ path: "module.json", bytes }, { path: "plugin.js", bytes: module }];
        const manifest = {
          format: "house-of-chances-hocpkg", formatVersion: 1,
          identity: { authorId: "example", packageName: `sort-${i}`, version: "1.0.0" },
          metadata: { title: `排序示例 ${i + 1}`, description: "中性拖动验证", tags: [], creators: [{ displayName: "示例作者", roles: ["design"] }] },
          resources: [{ id: "module", type: "plugin.module", apiVersion: PLUGIN_MODULE_API_VERSION, entry: "module.json", requires: [] }],
          files: await Promise.all(files.map(async file => ({ path: file.path, bytes: file.bytes.length, sha256: await sha256(file.bytes), mediaType: file.path.endsWith("json") ? "application/json" : "text/javascript" }))), extensions: {}
        };
        await repo.install({ manifest, async *files() { yield* files; } });
      }
    }, extra);
    await page.reload();
    await expect(page.locator("[data-start-game]")).toBeEnabled();
  }
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { ApplicationController } = await load("/src/application-controller.ts");
    const original = ApplicationController.prototype.setPluginOrder;
    (window as any).__sortWrites = [];
    ApplicationController.prototype.setPluginOrder = function (order: string[]) {
      (window as any).__sortWrites.push(order);
      if ((window as any).__failSort) return Promise.reject(new Error("模拟排序保存失败"));
      return original.call(this, order);
    };
  });
  await page.locator("[data-open-packages]").click();
  return page.locator(pluginCards).evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.packageId!));
}
async function writes(page: Page) { return page.evaluate(() => (window as any).__sortWrites as string[][]); }
async function start(page: Page, id: string) {
  const handle = page.locator(`${pluginCards}[data-package-id="${id}"] [data-plugin-drag]`);
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 5, point.y);
  await expect(page.locator(".plugin-drag-ghost")).toBeVisible();
  return point;
}
async function moveBelow(page: Page, id: string) {
  const box = (await page.locator(`${pluginCards}[data-package-id="${id}"]`).boundingBox())!;
  const list = (await page.locator(".package-list").boundingBox())!;
  await page.mouse.move(list.x + list.width / 2, Math.min(box.y + box.height * .8, list.y + list.height - 12));
}

for (const [width, height] of [[390, 844], [320, 720], [1280, 800]]) test(`插件跟手、占位、回弹、详情与持久顺序 ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const order = await open(page);
  const source = order[0], target = order[1];
  await page.locator(`${pluginCards}[data-package-id="${source}"] [data-toggle-package-details]`).click();
  // Expanded source keeps its exact height in the placeholder.
  const sourceHeight = (await page.locator(`${pluginCards}[data-package-id="${source}"]`).boundingBox())!.height;
  await start(page, source);
  expect((await page.locator(".plugin-drag-placeholder").boundingBox())!.height).toBeCloseTo(sourceHeight, 0);
  const before = (await page.locator(".plugin-drag-ghost").boundingBox())!;
  await page.mouse.move(before.x + before.width - 15, before.y + 10);
  await expect(page.locator(".plugin-drag-ghost")).toBeVisible();
  expect((await page.locator(".plugin-drag-ghost").boundingBox())!.y).not.toBe(before.y);
  expect(await writes(page)).toEqual([]);
  // Scroll while holding the source to reach the next plugin.
  await page.locator(".package-list").evaluate(list => { list.scrollTop = list.scrollHeight; });
  await page.locator(`${pluginCards}[data-package-id="${target}"]`).scrollIntoViewIfNeeded();
  await moveBelow(page, target);
  await expect.poll(() => page.locator(".plugin-drag-placeholder").evaluate(slot => slot.previousElementSibling?.getAttribute("data-package-id"))).toBe(target);
  const floating = (await page.locator(".plugin-drag-ghost").boundingBox())!;
  expect(floating.x).toBeGreaterThanOrEqual(0);
  expect(floating.x + floating.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath(`plugin-drag-${width}.png`) });
  expect(await writes(page)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => writes(page)).toEqual([[target, source]]);
  await expect(page.locator(".plugin-drag-ghost, .plugin-drag-placeholder, .plugin-drag-source")).toHaveCount(0);
  await expect(page.locator(`${pluginCards}[data-package-id="${source}"] [data-toggle-package-details]`)).toHaveAttribute("aria-expanded", "true");
  await page.reload(); await page.locator("[data-open-packages]").click();
  expect(await page.locator(pluginCards).evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.packageId))).toEqual([target, source]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("取消、区外释放、关闭、失焦与保存失败均能恢复并继续排序", async ({ page }) => {
  const order = await open(page);
  for (const cancel of ["escape", "outside", "pointercancel", "blur", "close"]) {
    await start(page, order[0]);
    if (cancel === "escape") await page.keyboard.press("Escape");
    if (cancel === "outside") { await page.mouse.move(3, 3); await page.mouse.up(); }
    if (cancel === "pointercancel") await page.locator("[data-package-drawer]").dispatchEvent("pointercancel");
    if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (cancel === "close") await page.evaluate(() => (document.querySelector("[data-package-drawer]") as HTMLDialogElement).close());
    await page.mouse.up();
    await expect(page.locator(".plugin-drag-ghost, .plugin-drag-placeholder, .plugin-drag-source")).toHaveCount(0);
    expect(await writes(page)).toEqual([]);
    if (cancel === "close") await page.locator("[data-open-packages]").click();
  }
  await page.evaluate(() => { (window as any).__failSort = true; });
  await start(page, order[0]); await moveBelow(page, order[1]);
  await expect.poll(() => page.locator(".plugin-drag-placeholder").evaluate(slot => slot.previousElementSibling?.getAttribute("data-package-id"))).toBe(order[1]);
  await page.mouse.up();
  await expect(page.locator("[data-launcher-status]")).toContainText("模拟排序保存失败");
  expect(await page.locator(pluginCards).evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.packageId))).toEqual(order);
  await page.evaluate(() => { (window as any).__failSort = false; });
  await page.locator(`${pluginCards}[data-package-id="${order[0]}"] [data-plugin-move="down"]`).click();
  await expect(page.locator(pluginCards).first()).toHaveAttribute("data-package-id", order[1]);
  await page.evaluate(() => document.body.classList.add("reduced-motion"));
  await start(page, order[1]);
  expect(await page.locator(".plugin-drag-ghost").evaluate(ghost => getComputedStyle(ghost).transform)).toBe("none");
  await page.keyboard.press("Escape"); await page.mouse.up();
});

test("触屏长按跟手，列表边缘自动滚动到末尾；减少动态效果关闭回弹", async ({ page }, info) => {
  const order = await open(page, 5);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const session = await page.context().newCDPSession(page);
  const handle = page.locator(`${pluginCards}[data-package-id="${order[0]}"] [data-plugin-drag]`);
  const box = (await handle.boundingBox())!;
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await expect(page.locator(".plugin-drag-ghost")).toBeVisible();
  expect(await page.locator(".plugin-drag-ghost").evaluate(ghost => getComputedStyle(ghost).transform)).toBe("none");
  const list = (await page.locator(".package-list").boundingBox())!;
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(list.x + list.width / 2), y: Math.round(list.y + list.height - 8) }] });
  await expect.poll(() => page.locator(".package-list").evaluate(list => list.scrollTop), { timeout: 15_000 }).toBeGreaterThan(600);
  await expect.poll(() => page.locator(".plugin-drag-placeholder").evaluate(slot => slot.previousElementSibling?.getAttribute("data-package-id")), { timeout: 15_000 }).toBe(order.at(-1));
  // Keep holding at the edge after reaching the last plugin. Auto-scroll must
  // not carry the preview into the following resource group before release.
  await page.waitForTimeout(1200);
  await expect(page.locator(".plugin-drag-placeholder")).not.toHaveClass(/is-invalid/);
  await expect.poll(() => page.locator(".plugin-drag-placeholder").evaluate(slot => slot.previousElementSibling?.getAttribute("data-package-id"))).toBe(order.at(-1));
  const floating = (await page.locator(".plugin-drag-ghost").boundingBox())!;
  expect(floating.y).toBeGreaterThanOrEqual(0);
  expect(floating.y + floating.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: info.outputPath("plugin-touch-auto-scroll.png") });
  expect(await writes(page)).toEqual([]);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => writes(page)).toEqual([[...order.slice(1), order[0]]]);
  await expect(page.locator(".plugin-drag-ghost, .plugin-drag-placeholder, .plugin-drag-source")).toHaveCount(0);
});
