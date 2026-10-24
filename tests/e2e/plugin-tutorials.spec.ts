import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

type Presentation = "popover" | "sidebar" | "modal";
interface Definition {
  id: string;
  title: string;
  pages: { body: string; resources?: { type: "image"; src: string; alt: string; caption?: string }[] }[];
  presentation?: Presentation;
  autoSkipMs?: number | null;
}
interface Fixture { name: string; apiVersion?: number; startup?: boolean; matchStart?: boolean }

function tutorialPackage({ name, apiVersion = 10, startup = false, matchStart = false }: Fixture): Buffer {
  const files: Record<string, Buffer> = {
    "module.json": Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [] })),
    "plugin.css": Buffer.from("/* Neutral tutorial contract fixture. */"),
    "plugin.js": Buffer.from(`export function register() { return { handlers: [], createRuntime() { return {
      mountRuntime(context, signal) {
        const probe = {
          context, signal, cancellations: [], controllers: [], disposed: false,
          hasTutorials: Object.hasOwn(context, 'tutorials'),
          show(definition, options = {}) {
            const controller = new AbortController();
            if (options.preAborted) controller.abort();
            this.controllers.push(controller);
            this.cancellations.push(context.tutorials.show(definition, { replay: options.replay, signal: controller.signal }));
            return this.cancellations.length - 1;
          },
          completed(id) { return context.tutorials.isCompleted(id); },
          cancel(index) { this.cancellations[index](); },
          abort(index) { this.controllers[index].abort(); }
        };
        (window.__tutorialProbes ??= {})[${JSON.stringify(name)}] = probe;
        if (${startup} && probe.hasTutorials) probe.show({
          id: 'welcome', title: ${JSON.stringify(`${name}入门`)},
          pages: [{ body: '中性插件的第一步。' }, { body: '中性插件的第二步。' }], autoSkipMs: null
        });
        probe.surfaceAtMount = Boolean(document.querySelector('#tutorial-popover'));
        const seenMatches = new Set();
        const releaseMatch = ${matchStart} ? context.game.subscribe(() => {
          const match = context.game.getMatch();
          if (!match || seenMatches.has(match.id)) return;
          seenMatches.add(match.id);
          probe.show({ id: 'table-intro', title: '牌桌操作说明', presentation: 'sidebar',
            pages: [{ body: '进入牌桌后，插件可在一旁介绍当前功能。' }], autoSkipMs: null });
        }) : undefined;
        return () => { releaseMatch?.(); probe.disposed = true; };
      }
    }; } }; }`)
  };
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: name, version: "1.0.0" },
    metadata: { title: name, description: "中性教程插件验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion, entry: "module.json", requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({
      path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css"
    })), extensions: {}
  };
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}

async function install(page: Page, fixtures: Fixture[] = [{ name: "alpha" }]): Promise<void> {
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator("[data-import-file]").setInputFiles({
    name: "tutorial-fixtures.zip", mimeType: "application/zip",
    buffer: Buffer.from(zipSync(Object.fromEntries(fixtures.map(fixture => [`${fixture.name}.hocpkg`, tutorialPackage(fixture)]))))
  });
  await page.getByRole("button", { name: "安装所选包" }).click();
  for (const { name } of fixtures) {
    await page.locator(`[data-package-action="enable"][data-package-id="test/${name}"]`).click();
    await expect(page.locator(`.package-card[data-package-id="test/${name}"]`)).toHaveAttribute("data-package-state", "enabled");
  }
  await page.getByRole("button", { name: "关闭资源管理" }).click();
}

async function start(page: Page): Promise<void> {
  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async warning => {
    await warning.locator("[data-acknowledge-third-party-content]").click();
  });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async warning => {
    await warning.locator("[data-acknowledge-adult-content]").click();
  });
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
}

async function show(page: Page, definition: Definition, options: { name?: string; replay?: boolean; preAborted?: boolean } = {}): Promise<number> {
  return page.evaluate(({ definition, options }) => (window as any).__tutorialProbes[options.name ?? "alpha"].show(definition, options), { definition, options });
}

async function completed(page: Page, id: string, name = "alpha"): Promise<boolean> {
  return page.evaluate(({ id, name }) => (window as any).__tutorialProbes[name].completed(id), { id, name });
}

async function savedIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    return (await createPersistenceService().loadLongTerm()).tutorialProgress.completedIds;
  });
}

const onePage = (id: string, presentation: Presentation = "popover"): Definition => ({
  id, title: id, pages: [{ body: `中性教程：${id}` }], presentation, autoSkipMs: null
});

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("runtime startup queues package-isolated tutorials after acknowledgement and persists completion and replay", async ({ page }) => {
  await install(page, [{ name: "alpha", startup: true }, { name: "beta", startup: true }]);
  await page.locator("[data-start-game]").click();
  await expect(page.locator("#third-party-content-warning")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tutorialProbes)).toBeUndefined();
  await page.locator("[data-acknowledge-third-party-content]").click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  await expect(page.locator("#tutorial-popover")).toHaveCount(0);
  await page.locator("[data-acknowledge-adult-content]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  expect(await page.evaluate(() => Object.values((window as any).__tutorialProbes).map((probe: any) => probe.surfaceAtMount))).toEqual([false, false]);
  const baseline = (await savedIds(page)).length;
  const surface = page.locator("#tutorial-popover");
  await expect(surface).toHaveCount(1);
  await expect(surface).toContainText("alpha入门");
  await expect(surface).toHaveAttribute("data-presentation", "popover");
  await surface.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(surface).toContainText("中性插件的第二步。");
  await surface.getByRole("button", { name: "上一步", exact: true }).click();
  await expect(surface).toContainText("中性插件的第一步。");
  await surface.getByRole("button", { name: "下一步", exact: true }).click();
  await surface.getByRole("button", { name: "好的", exact: true }).click();
  expect(await completed(page, "welcome", "alpha")).toBe(true);
  expect(await completed(page, "welcome", "beta")).toBe(false);
  await expect(surface).toContainText("beta入门");
  await surface.getByRole("button", { name: "跳过", exact: true }).click();
  await expect(surface).toHaveCount(0);
  expect(await completed(page, "welcome", "beta")).toBe(true);
  await expect.poll(async () => (await savedIds(page)).length).toBe(baseline + 2);
  await page.reload();
  await start(page);
  await expect(surface).toHaveCount(0);
  expect(await completed(page, "welcome", "alpha")).toBe(true);
  expect(await completed(page, "welcome", "beta")).toBe(true);
  await show(page, onePage("welcome"));
  await expect(surface).toHaveCount(0);
  await show(page, { ...onePage("welcome", "sidebar"), title: "手动回看" }, { replay: true });
  await expect(surface).toContainText("手动回看");
  await surface.getByRole("button", { name: "好的", exact: true }).click();
  await expect(surface).toHaveCount(0);
  expect((await savedIds(page)).length).toBe(baseline + 2);
});

test("cancellation, abort, navigation and runtime exit release active and queued tutorials without completing them", async ({ page }) => {
  await install(page); await start(page);
  const surface = page.locator("#tutorial-popover");
  const first = await show(page, onePage("abort-active"));
  const queued = await show(page, onePage("abort-queued"));
  await page.evaluate(index => (window as any).__tutorialProbes.alpha.abort(index), queued);
  await expect(surface).toContainText("abort-active");
  await page.evaluate(index => (window as any).__tutorialProbes.alpha.abort(index), first);
  await expect(surface).toHaveCount(0);
  await show(page, onePage("already-aborted"), { preAborted: true });
  await expect(surface).toHaveCount(0);
  const canceled = await show(page, onePage("cancel-active"));
  const next = await show(page, onePage("cancel-next"));
  await page.evaluate(index => (window as any).__tutorialProbes.alpha.cancel(index), canceled);
  await expect(surface).toContainText("cancel-next");
  // Releasing an old request twice must not cancel the next request.
  await page.evaluate(index => (window as any).__tutorialProbes.alpha.cancel(index), canceled);
  await expect(surface).toContainText("cancel-next");
  await page.evaluate(index => (window as any).__tutorialProbes.alpha.cancel(index), next);
  await show(page, onePage("navigation-active"));
  await show(page, onePage("navigation-queued"));
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator(".lobby-character-shell")).toBeVisible();
  await expect(surface).toHaveCount(0);
  await page.locator("[data-lobby-home]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect(surface).toHaveCount(0);
  for (const id of ["abort-active", "abort-queued", "already-aborted", "cancel-active", "cancel-next", "navigation-active", "navigation-queued"]) {
    expect(await completed(page, id)).toBe(false);
  }
  await show(page, onePage("exit-active"));
  await show(page, onePage("exit-queued"));
  await page.locator("[data-exit-launcher]").click();
  await expect(page.locator("[data-start-game]")).toBeVisible();
  await expect(surface).toHaveCount(0);
  expect(await page.evaluate(() => {
    const probe = (window as any).__tutorialProbes.alpha;
    return { disposed: probe.disposed, aborted: probe.signal.aborted };
  })).toEqual({ disposed: true, aborted: true });
  await show(page, onePage("stale-runtime"));
  await expect(surface).toHaveCount(0);
  await start(page);
  expect(await completed(page, "exit-active")).toBe(false);
  expect(await completed(page, "exit-queued")).toBe(false);
  await show(page, onePage("new-runtime"));
  await expect(surface).toContainText("new-runtime");
});

for (const presentation of ["popover", "sidebar", "modal"] as const) {
  test(`${presentation} handles long escaped content at desktop, 390px and 320px widths`, async ({ page }, testInfo) => {
    await install(page); await start(page);
    const title = '<img src=x onerror="window.__tutorialInjection=true">';
    const body = '中性内容 <script>window.__tutorialInjection=true</script> & "引号"。';
    const surface = page.locator("#tutorial-popover");
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      await page.setViewportSize(viewport);
      await page.locator("[data-enter-duel]").focus();
      await show(page, {
        id: `${presentation}-${viewport.width}`, presentation, title, autoSkipMs: null,
        pages: [{ body: body.repeat(100), resources: [{
          type: "image", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=",
          alt: '中性示意图 " <img>', caption: "<b>图片说明</b>"
        }] }]
      });
      await expect(surface).toBeVisible();
      await expect(surface).toHaveAttribute("data-presentation", presentation);
      await expect(surface.locator("h2")).toHaveText(title);
      await expect(surface).toContainText(body);
      await expect(surface.locator("script, b")).toHaveCount(0);
      await expect(surface.locator("img")).toHaveCount(1);
      await expect(surface.locator("img")).toHaveAttribute("alt", '中性示意图 " <img>');
      await expect.poll(() => surface.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
      await expect(surface.locator("figcaption")).toHaveText("<b>图片说明</b>");
      expect(await page.evaluate(() => (window as any).__tutorialInjection)).toBeUndefined();
      expect(await surface.evaluate(element => element.matches(":modal"))).toBe(presentation === "modal");
      await expect(surface).toHaveAttribute("aria-modal", String(presentation === "modal"));
      await expect.poll(async () => {
        const box = await surface.boundingBox();
        return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      }).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (presentation === "sidebar") {
        const box = (await surface.boundingBox())!;
        if (viewport.width > 600) expect(box.x).toBeGreaterThan(viewport.width / 2);
        else expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 24);
      }
      if (presentation === "modal") {
        expect(await surface.evaluate(element => element.contains(document.activeElement))).toBe(true);
        for (let step = 0; step < 5; step++) {
          await page.keyboard.press("Tab");
          // Native dialogs allow focus to visit browser chrome, but never the inert game behind them.
          expect(await surface.evaluate(element => !document.hasFocus() || element.contains(document.activeElement))).toBe(true);
        }
      }
      const finish = surface.getByRole("button", { name: "好的", exact: true });
      await finish.scrollIntoViewIfNeeded();
      const finishBox = (await finish.boundingBox())!;
      expect(finishBox.y).toBeGreaterThanOrEqual(0);
      expect(finishBox.y + finishBox.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(finishBox.height).toBeGreaterThanOrEqual(44);
      if (viewport.width === 320) await page.screenshot({ path: testInfo.outputPath(`${presentation}-320.png`), fullPage: true });
      if (presentation === "modal") {
        await finish.focus();
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-enter-duel]")).toBeFocused();
      } else await finish.click();
      await expect(surface).toHaveCount(0);
      expect(await completed(page, `${presentation}-${viewport.width}`)).toBe(true);
    }
  });
}

test("popover defaults to ten seconds, sidebar and modal wait, and interacting cancels automatic completion", async ({ page }) => {
  await install(page); await start(page);
  await page.evaluate(() => {
    const original = window.setTimeout.bind(window);
    (window as any).__tutorialTimeouts = [];
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      (window as any).__tutorialTimeouts.push(timeout);
      return original(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  const surface = page.locator("#tutorial-popover");
  for (const presentation of ["popover", "sidebar", "modal"] as const) {
    const result = await page.evaluate(presentation => {
      (window as any).__tutorialTimeouts = [];
      const index = (window as any).__tutorialProbes.alpha.show({ id: `default-${presentation}`, title: "默认计时", presentation, pages: [{ body: "默认计时验证。" }] });
      return { index, timeouts: (window as any).__tutorialTimeouts };
    }, presentation);
    await expect(surface).toBeVisible();
    if (presentation === "popover") expect(result.timeouts).toContain(10_000);
    else expect(result.timeouts).toEqual([]);
    await page.evaluate(index => (window as any).__tutorialProbes.alpha.cancel(index), result.index);
  }
  await show(page, { ...onePage("automatic"), autoSkipMs: 1_000 });
  await expect.poll(() => completed(page, "automatic")).toBe(true);
  await expect(surface).toHaveCount(0);
  await show(page, { id: "interactive", title: "手动阅读", pages: [{ body: "点击后停留。" }, { body: "翻页后继续停留。" }], autoSkipMs: 1_000 });
  await surface.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(surface).toContainText("翻页后继续停留。");
  await page.waitForTimeout(1_500);
  await expect(surface).toBeVisible();
  expect(await completed(page, "interactive")).toBe(false);
  await surface.getByRole("button", { name: "好的", exact: true }).click();
  expect(await completed(page, "interactive")).toBe(true);
});

test("skipTutorial suppresses automatic and replay requests while API 9 keeps its original context", async ({ page }) => {
  await install(page, [{ name: "alpha", startup: true }, { name: "legacy", apiVersion: 9 }]);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const repository = createPersistenceService();
    const save = await repository.loadLongTerm() ?? createDefaultSave();
    await repository.saveLongTerm({ ...save, skipTutorial: true });
  });
  await page.reload();
  await start(page);
  expect(await page.evaluate(() => ({
    current: (window as any).__tutorialProbes.alpha.hasTutorials,
    legacy: (window as any).__tutorialProbes.legacy.hasTutorials
  }))).toEqual({ current: true, legacy: false });
  await expect(page.locator("#tutorial-popover")).toHaveCount(0);
  await show(page, onePage("manual-skipped", "modal"), { replay: true });
  await expect(page.locator("#tutorial-popover")).toHaveCount(0);
  expect(await completed(page, "welcome")).toBe(false);
  expect(await completed(page, "manual-skipped")).toBe(false);
});

test("a tutorial offered by the first match subscription survives the transition onto the real table", async ({ page }) => {
  await install(page, [{ name: "alpha", matchStart: true }]); await start(page);
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator("main.lobby-character-shell")).toBeVisible();
  await page.locator("[data-invite-character]").first().click();
  await expect(page.locator("#profile")).toBeVisible();
  await page.locator("#profile [data-profile-start]").click();
  await expect(page.locator("main.table-shell")).toBeVisible();
  const surface = page.locator("#tutorial-popover");
  await expect(surface).toHaveAttribute("data-presentation", "sidebar");
  await expect(surface).toContainText("牌桌操作说明");
  expect(await completed(page, "table-intro")).toBe(false);
  await surface.getByRole("button", { name: "好的", exact: true }).click();
  await expect(surface).toHaveCount(0);
  expect(await completed(page, "table-intro")).toBe(true);
  await expect(page.locator("main.table-shell")).toBeVisible();
});
