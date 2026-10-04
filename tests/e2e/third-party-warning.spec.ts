import { expect, test, type Page } from "@playwright/test";

async function installProbe(page: Page, packageName = "warning-probe"): Promise<void> {
  await page.evaluate(async (packageName) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createDefaultContentHostProviders } = await load("/src/content/storage/host-factory.ts");
    const { resolveContentHost } = await load("/src/content/storage/contracts.ts");
    const { FileContentRepository } = await load("/src/content/storage/repository.ts");
    const { sha256 } = await load("/src/content/storage/encoding.ts");
    const { PLUGIN_MODULE_API_VERSION } = await load("/src/content/packages/plugin-version.ts");
    const host = await resolveContentHost(createDefaultContentHostProviders());
    const files = new Map<string, Uint8Array>([
      ["resources/plugin.json", new TextEncoder().encode(JSON.stringify({ module: "probe.js", style: "probe.css", provides: [] }))],
      ["probe.js", new TextEncoder().encode("globalThis.__warningProbeExecutions = (globalThis.__warningProbeExecutions ?? 0) + 1; export function register() { return { handlers: [], createRuntime() { return {}; } }; }")],
      ["probe.css", new TextEncoder().encode("/* Neutral warning-order test fixture. */")]
    ]);
    const manifest = {
      format: "house-of-chances-hocpkg", formatVersion: 1,
      identity: { authorId: "example", packageName, version: "1.0.0" },
      metadata: { title: "中性启动验证插件", description: "仅记录模块执行次数。", tags: [], creators: [{ displayName: "示例作者", roles: ["design"] }] },
      resources: [{ id: "module", type: "plugin.module", apiVersion: PLUGIN_MODULE_API_VERSION, entry: "resources/plugin.json", requires: [] }],
      files: await Promise.all([...files].map(async ([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" }))),
      extensions: {}
    };
    await new FileContentRepository(host).install({ manifest, async *files() { for (const [path, bytes] of files) yield { path, bytes }; } });
  }, packageName);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
}

async function executions(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __warningProbeExecutions?: number }).__warningProbeExecutions ?? 0);
}

async function confirmed(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    return (await createPersistenceService().loadLongTerm())?.tutorialProgress.completedIds.includes("third-party-content-warning") ?? false;
  });
}

test("third-party warning gates plugin execution, precedes adult warning and persists across reload and new packages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await installProbe(page);
  await page.locator("[data-start-game]").click();
  const warning = page.locator("#third-party-content-warning");
  await expect(warning).toBeVisible();
  await expect(page.locator(".loading-shell")).toBeVisible();
  await expect(page.locator("#adult-content-warning")).toHaveCount(0);
  expect(await executions(page)).toBe(0);
  await warning.locator("[data-acknowledge-third-party-content]").click();
  await expect(warning).toHaveCount(0);
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  expect(await executions(page)).toBe(1);
  expect(await confirmed(page)).toBe(true);
  await page.locator("[data-acknowledge-adult-content]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator("[data-exit-launcher]").click();
  await page.reload();
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect(page.locator("#third-party-content-warning, #adult-content-warning")).toHaveCount(0);
  await page.locator("[data-exit-launcher]").click();
  await installProbe(page, "another-probe");
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect(warning).toHaveCount(0);
  expect(await executions(page)).toBe(2);
  await page.locator("[data-exit-launcher]").click();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    await createPersistenceService().deleteLongTerm();
  });
  await page.reload();
  await page.locator("[data-start-game]").click();
  await expect(warning).toBeVisible();
  expect(await executions(page)).toBe(0);
});

test("cancel returns to resource management without executing or acknowledging the plugin", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await installProbe(page);
  await page.locator("[data-start-game]").click();
  await page.locator("[data-cancel-third-party-content]").click();
  await expect(page.locator("[data-package-drawer]")).toBeVisible();
  await expect(page.locator("#third-party-content-warning, #adult-content-warning")).toHaveCount(0);
  expect(await executions(page)).toBe(0);
  expect(await confirmed(page)).toBe(false);
  await page.locator('[data-package-id="example/warning-probe"] [data-package-action="disable"]').click();
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  await expect(page.locator("#third-party-content-warning")).toHaveCount(0);
  expect(await executions(page)).toBe(0);
});

test("adult confirmation does not suppress the first third-party warning", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-start-game]").click();
  await page.locator("[data-acknowledge-adult-content]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.locator("[data-exit-launcher]").click();
  await installProbe(page);
  await page.locator("[data-start-game]").click();
  await expect(page.locator("#third-party-content-warning")).toBeVisible();
  expect(await executions(page)).toBe(0);
  await page.locator("[data-acknowledge-third-party-content]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect(page.locator("#adult-content-warning")).toHaveCount(0);
});

test("save failure keeps the warning and plugin gate closed until retry succeeds", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await installProbe(page);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { PersistenceService } = await load("/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.saveLongTerm;
    let fail = true;
    PersistenceService.prototype.saveLongTerm = function (save: any) {
      if (fail && save.tutorialProgress.completedIds.includes("third-party-content-warning")) {
        fail = false;
        return Promise.reject(new Error("Injected acknowledgement write failure"));
      }
      return original.call(this, save);
    };
  });
  await page.locator("[data-start-game]").click();
  await page.locator("[data-acknowledge-third-party-content]").click();
  await expect(page.locator(".third-party-content-warning-status")).toHaveText("确认状态保存失败，请重试。");
  await expect(page.locator("[data-acknowledge-third-party-content]")).toBeEnabled();
  expect(await executions(page)).toBe(0);
  expect(await confirmed(page)).toBe(false);
  expect(await page.locator("#app").evaluate((root) => root.inert)).toBe(true);
  await page.locator("[data-acknowledge-third-party-content]").click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  expect(await executions(page)).toBe(1);
  expect(await confirmed(page)).toBe(true);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }]) {
  test(`warning is scrollable and both actions remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator("[data-start-game]")).toBeEnabled();
    await installProbe(page);
    await page.locator("[data-start-game]").click();
    const warning = page.locator("#third-party-content-warning");
    await expect(warning).toBeVisible();
    const bounds = await warning.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("[data-acknowledge-third-party-content]").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-acknowledge-third-party-content]")).toBeInViewport();
    await expect(page.locator("[data-cancel-third-party-content]")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("third-party-warning.png") });
    await page.locator("[data-cancel-third-party-content]").click();
    await expect(page.locator("[data-package-drawer]")).toBeVisible();
  });
}
