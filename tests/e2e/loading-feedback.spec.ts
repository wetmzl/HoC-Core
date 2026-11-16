import { expect, test, type Page } from "@playwright/test";

/** Real launcher DOM, with controllable I/O boundaries instead of timing-dependent large files. */
async function mountFixture(page: Page, holdMount = false): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/loading-feedback-fixture", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>'
  }));
  await page.goto("/loading-feedback-fixture");
  await page.clock.install();
  await page.evaluate(async hold => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/styles.css");
    const { LauncherView } = await load("/src/launcher.ts");
    let releaseMount!: () => void;
    const mountGate = new Promise<void>(resolve => { releaseMount = resolve; });
    let sessions: unknown[] = [];
    const session = {
      id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-11-04T00:00:00Z", filename: "neutral.hocpkg",
      candidates: [{ id: "0001", kind: "package", packageId: "neutral/loading", source: "neutral.hocpkg", version: "1.0.0", title: "中性资源包", digest: "fixture" }]
    };
    let stageOptions: any;
    let installOptions: any;
    let aggregate: ((progress: unknown) => void) | undefined;
    let releaseStage: (() => void) | undefined;
    let releaseInstall: (() => void) | undefined;
    let aborted = false;
    const controller = {
      contentSource: "repository", hasImportPicker: false, warnings: [],
      async listPackages() { if (hold) await mountGate; return []; },
      async listImportSessions() { return sessions; },
      async listArchivedPackages() { return []; },
      async listPlaylists() { return []; },
      async currentPlaylistId() { return null; },
      async releaseImportFile() {},
      async previewImportCandidate() { throw new Error("No optional preview in this fixture"); },
      async removeImportSession() { sessions = []; },
      stagePackageFile(_file: File, options: any) {
        stageOptions = options;
        return new Promise((resolve, reject) => {
          releaseStage = () => { sessions = [session]; resolve(session); };
          options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once: true });
        });
      },
      installStagedPackages(_session: string, _ids: string[], onProgress: (progress: unknown) => void, options: any) {
        installOptions = options;
        aggregate = onProgress;
        return new Promise(resolve => { releaseInstall = () => resolve([]); });
      }
    };
    const launcher = new LauncherView(document.querySelector("#app"), controller);
    const mounted = launcher.mount();
    (window as any).__loadingFixture = {
      finishMount: async () => { releaseMount(); await mounted; },
      stageReady: () => Boolean(stageOptions),
      installReady: () => Boolean(installOptions),
      stageProgress: (phase: string, completedBytes: number, totalBytes: number) => stageOptions.onProgress({ phase, path: "resources/file.bin", completedBytes, totalBytes }),
      finishStage: () => releaseStage?.(),
      ioProgress: (completedBytes: number, totalBytes: number) => installOptions.onIoProgress({ phase: "copying", path: "resources/file.bin", completedBytes, totalBytes }),
      aggregateProgress: (completedBytes: number, totalBytes: number) => aggregate?.({ packageId: "neutral/loading", path: "resources/file.bin", completedBytes, totalBytes }),
      commit: () => installOptions.onCommit(),
      finishInstall: () => releaseInstall?.(),
      wasAborted: () => aborted
    };
    if (!hold) await mounted;
  }, holdMount);
  return errors;
}

async function startImport(page: Page): Promise<void> {
  await page.locator("[data-open-packages]").click();
  await page.locator("[data-import-file]").setInputFiles({ name: "neutral.hocpkg", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await expect.poll(() => page.evaluate(() => (window as any).__loadingFixture.stageReady())).toBe(true);
  await expect(page.locator("[data-import-dialog] [data-loading-indicator]")).toBeVisible();
}

test("读取进度保持不定状态，长等待提示恢复后消失，取消会中止真实操作", async ({ page }) => {
  const errors = await mountFixture(page, true);
  const startup = page.locator("[data-loading-indicator]");
  await expect(startup).toBeVisible();
  await expect(startup.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", /.+/);
  await page.evaluate(() => (window as any).__loadingFixture.finishMount());
  await expect(startup).toHaveCount(0);
  await startImport(page);

  const dialog = page.locator("[data-import-dialog]");
  const bar = dialog.getByRole("progressbar");
  await page.evaluate(() => { (window as any).__loadingCard = document.querySelector(".hoc-loading-card"); });
  for (const total of [0, 128]) {
    await page.clock.fastForward(150);
    await page.evaluate(total => (window as any).__loadingFixture.stageProgress("copying", 128, total), total);
    await expect(bar).not.toHaveAttribute("aria-valuenow", /.+/);
    await expect(dialog.locator("[data-loading-value]")).toHaveText("");
  }
  expect(await page.evaluate(() => document.querySelector(".hoc-loading-card") === (window as any).__loadingCard)).toBe(true);

  await page.clock.fastForward(35_000);
  await expect(dialog.locator("[data-loading-notice]")).toBeVisible();
  await expect(dialog.locator("[data-loading-notice]")).toHaveText("暂未收到新进度");
  await page.evaluate(() => (window as any).__loadingFixture.stageProgress("verifying", 128, 128));
  await expect(dialog.locator("[data-loading-notice]")).toBeHidden();
  await dialog.locator("[data-import-cancel]").click();
  await expect.poll(() => page.evaluate(() => (window as any).__loadingFixture.wasAborted())).toBe(true);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("安装仅使用累计进度，原位更新牌背，保存期间不能取消", async ({ page }) => {
  const errors = await mountFixture(page);
  await startImport(page);
  await page.evaluate(() => (window as any).__loadingFixture.finishStage());
  await expect(page.locator("[data-import-next]")).toBeEnabled();
  await page.locator("[data-import-next]").click();
  await expect.poll(() => page.evaluate(() => (window as any).__loadingFixture.installReady())).toBe(true);
  const dialog = page.locator("[data-import-dialog]");
  const bar = dialog.getByRole("progressbar");

  await page.clock.fastForward(150);
  await page.evaluate(() => (window as any).__loadingFixture.ioProgress(128, 128));
  await expect(bar).not.toHaveAttribute("aria-valuenow", /.+/);
  await page.evaluate(() => { (window as any).__loadingCard = document.querySelector(".hoc-loading-card"); });
  for (const value of [25, 60]) {
    await page.clock.fastForward(150);
    await page.evaluate(value => (window as any).__loadingFixture.aggregateProgress(value, 100), value);
    await expect(bar).toHaveAttribute("aria-valuenow", String(value));
    await expect(dialog.locator("[data-loading-value]")).toHaveText(`${value}%`);
  }
  expect(await page.evaluate(() => document.querySelector(".hoc-loading-card") === (window as any).__loadingCard)).toBe(true);
  await page.clock.fastForward(150);
  await page.evaluate(() => (window as any).__loadingFixture.ioProgress(128, 0));
  await expect(bar).toHaveAttribute("aria-valuenow", "60");

  await page.evaluate(() => (window as any).__loadingFixture.commit());
  await expect(dialog.locator("[data-import-cancel]")).toBeDisabled();
  await expect(dialog.locator("[data-loading-label]")).toHaveText("保存中");
  await expect(bar).not.toHaveAttribute("aria-valuenow", /.+/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).__loadingFixture.finishInstall());
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("320px 下加载窗口无溢出，减少动态时关闭循环动画", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const errors = await mountFixture(page);
  await startImport(page);
  const metrics = await page.locator("[data-import-dialog]").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
      documentOverflow: document.documentElement.scrollWidth > innerWidth, contentOverflow: element.scrollWidth > element.clientWidth };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.documentOverflow).toBe(false);
  expect(metrics.contentOverflow).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.locator("[data-loading-indicator]").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(page.locator("[data-loading-label]")).toBeVisible();
  expect(errors).toEqual([]);
});
