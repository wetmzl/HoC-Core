import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const screenshotDirectory = process.env.HOC_ACHIEVEMENT_SCREENSHOT_DIR ?? "output/achievement-toast-overlay";
mkdirSync(screenshotDirectory, { recursive: true });
const prefix = "example/achievement-ui#catalog/";
const viewports = [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 1280, height: 900 }];

/** Neutral catalog and observations use the same projection, durable commit and UI as installed content. */
async function mountFixture(page: Page, options: { table?: boolean; empty?: boolean; observations?: number; soundEnabled?: boolean } = {}): Promise<void> {
  await page.route("**/v1/events", route => route.abort());
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async options => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
    await bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const save = createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = options.soundEnabled ?? false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repository = createPersistenceService();
    await repository.saveLongTerm(save);
    if (options.table) {
      const { loadCharacter } = await load("/src/content/characters/loader.ts");
      const { createMatch } = await load("/src/core/match/reducer.ts");
      const { createCard } = await load("/src/core/blackjack/card.ts");
      const character = await loadCharacter("deepseek");
      const base = createMatch("achievement-ui-layout", { opponentId: character.id, opponentAiSkills: [] });
      const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", "2", `achievement-${i}`));
      const player = { ...base.player, hand: { cards: cards.slice(0, 2) } };
      const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) } };
      const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
        playerSkills: { ...base.playerSkills, drawCount: 2, drawOffer: null },
        round: { ...base.round, player, opponent, phase: "turns", currentActor: "player" },
        history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
      await repository.saveRuntime(createRuntimeSave(match));
    } else await repository.deleteRuntime();
    const api = await load("/src/authoring-api.ts");
    const { gameAchievements, installAchievementUiCatalog } = await load("/src/runtime/achievement-ui.ts");
    const topic = { type: "example.achievement-ui", apiVersion: 1 };
    const icons = [
      { color: "#e5b34e", path: '<path d="M27 24h26v13c0 15-26 15-26 0z"/><path d="M27 27H17v7c0 8 6 11 13 11m23-18h10v7c0 8-6 11-13 11M40 49v11M29 61h22"/>' },
      { color: "#70cdd0", path: '<path d="m40 16 21 10v17c0 14-21 22-21 22S19 57 19 43V26z"/><path d="m29 40 8 8 15-18"/>' },
      { color: "#c795ef", path: '<path d="m40 15 7 16 18 2-14 12 4 18-15-9-15 9 4-18-14-12 18-2z"/>' },
      { color: "#90b6d2", path: '<path d="M25 18h30v45H25z"/><path d="m40 30 8 10-8 10-8-10z"/>' }
    ];
    const image = (index: number) => {
      const icon = icons[index % icons.length];
      return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 80 80"><defs><radialGradient id="g"><stop stop-color="${icon.color}" stop-opacity=".35"/><stop offset="1" stop-color="#10202d"/></radialGradient></defs><rect width="80" height="80" rx="10" fill="url(#g)"/><g fill="none" stroke="${icon.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${icon.path}</g></svg>`)}`;
    };
    const metadata = [
      ["first-steps", "初露锋芒", "完成第一次牌局挑战。", 1],
      ["steady-hand", "沉着应对", "在牌桌上保持冷静，完成两次挑战。", 2],
      ["lucky-break", "好运眷顾", "让好运站在你这边，完成三次挑战。", 3],
      ["ten-rounds", "久经牌局", "完成十次挑战，留下属于你的牌桌记录。", 10],
      ["keep-going", "稳步向前", "每一次尝试，都是向前的一步。完成八次挑战。", 8],
      ["hidden-secret", "SECRET_UI_HIDDEN_TITLE", "SECRET_UI_HIDDEN_DESCRIPTION", 100]
    ];
    const entries = options.empty ? [] : metadata.map(([id, name, description, target], index) => ({
      key: `example/achievement-ui#catalog/${id}`,
      packageId: "example/achievement-ui", catalogKey: "example/achievement-ui#catalog", packageTitle: "成就界面示例", packageVersion: "1.0.0",
      definition: api.AchievementDefinitionSchema.parse({ id, revision: 1, name, description, category: "牌桌足迹",
        ...(index === 4 ? {} : { cover: `cover-${index}.svg` }), hidden: index === 5,
        progressDisplay: { metric: "n", target },
        tracking: { scope: "profile", tracks: [{ id: "n", on: [topic], progress: { type: "count" } }],
          completeWhen: { type: "scalar-compare", left: { type: "metric", id: "n" }, operator: "gte", right: target } } }),
      ...(index === 4 ? {} : { coverUrl: image(index) })
    }));
    installAchievementUiCatalog(entries);
    const service = gameAchievements();
    await service.ready();
    (window as any).__achievementUiFixture = { api, entries, topic, service };
    for (let i = 0; i < (options.observations ?? 3); i++) {
      const ledger = service.checkpoint.ledger;
      const evaluation = api.advanceAchievements(entries, ledger, {
        apiVersion: 1, streamId: ledger.streamId, sequence: ledger.nextSequence,
        at: `2026-11-10T0${i + 1}:20:00Z`, topic, scopes: {}, debugUsed: false, values: {}, skillCards: {}
      }, [{ topic, values: {}, skillCollections: [] }]);
      await service.submit(evaluation.ledger);
    }
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    await mountGameRuntime({ root: document.querySelector<HTMLDivElement>("#app")!, onExitRequest: async () => {} });
  }, options);
  await expect(page.locator(options.table ? ".table-playing" : ".lobby-menu-shell")).toBeVisible();
}

async function observe(page: Page, at = "2026-11-10T08:30:00Z"): Promise<void> {
  await page.evaluate(async at => {
    const { api, entries, topic, service } = (window as any).__achievementUiFixture;
    const ledger = service.checkpoint.ledger;
    const evaluation = api.advanceAchievements(entries, ledger, { apiVersion: 1, streamId: ledger.streamId,
      sequence: ledger.nextSequence, at, topic, scopes: {}, debugUsed: false, values: {}, skillCards: {} },
      [{ topic, values: {}, skillCollections: [] }]);
    await service.submit(evaluation.ledger);
  }, at);
}

for (const viewport of viewports) {
  test(`成就总览按解锁时间倒序，隐藏汇总与进度兼容 ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await mountFixture(page);
    const entry = page.locator('[data-ui-action="achievements"]');
    const settings = page.locator('[data-ui-action="settings"]');
    await expect(entry).toBeVisible();
    const [entryBox, settingsBox] = await Promise.all([entry.boundingBox(), settings.boundingBox()]);
    expect(Math.abs(entryBox!.y - settingsBox!.y)).toBeLessThan(2);
    if (viewport.width === 390) await page.screenshot({ path: `${screenshotDirectory}/menu-entry-390.png` });
    await entry.click();
    const dialog = page.locator(".achievement-overview");
    await expect(dialog).toBeVisible();
    expect(await dialog.locator(".is-completed[data-achievement-key]").evaluateAll(rows => rows.map(row => row.getAttribute("data-achievement-key")))).toEqual([
      `${prefix}lucky-break`, `${prefix}steady-hand`, `${prefix}first-steps`
    ]);
    await expect(dialog).toContainText("久经牌局");
    await expect(dialog).toContainText("隐藏成就");
    await expect(dialog).not.toContainText("SECRET_UI");
    expect(await dialog.locator('[data-achievement-key*="hidden-secret"]').count()).toBe(0);
    const locked = dialog.locator(`[data-achievement-key="${prefix}ten-rounds"]`);
    await expect(locked).toContainText(/3\s*[/／]\s*10/);
    expect(await locked.locator(".achievement-cover").evaluate(cover => getComputedStyle(cover).filter)).toContain("grayscale(1)");
    const fits = await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight && element.scrollWidth <= element.clientWidth;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: `${screenshotDirectory}/overview-${viewport.width}.png` });
    await info.attach(`overview-${viewport.width}`, { path: `${screenshotDirectory}/overview-${viewport.width}.png`, contentType: "image/png" });
    if (viewport.width === 390) {
      await dialog.locator(".achievement-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(dialog.locator(".achievement-hidden-summary")).toBeInViewport();
      await page.screenshot({ path: `${screenshotDirectory}/overview-locked-390.png` });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(entry).toBeFocused();
    await entry.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  });
}

test("无目录时显示空状态，打开和关闭成就不产生假解锁", async ({ page }) => {
  await mountFixture(page, { empty: true, observations: 0 });
  await page.locator('[data-ui-action="achievements"]').click();
  await expect(page.locator(".achievement-overview")).toContainText(/暂无|还没有|尚未/);
  await expect(page.locator(".achievement-overview [data-achievement-key]")).toHaveCount(0);
  await expect(page.locator(".achievement-toast")).toHaveCount(0);
  await page.screenshot({ path: `${screenshotDirectory}/empty-390.png` });
});

async function freezeClock(page: Page): Promise<void> {
  const start = Date.UTC(2026, 10, 10, 8);
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
}

async function progress(page: Page): Promise<number> {
  return page.locator(".achievement-toast-progress").evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return matrix.a;
  });
}

async function setForeground(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(visible => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
  await page.clock.runFor(32);
}

async function tableGeometry(page: Page): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  return page.evaluate(() => Object.fromEntries([
    ".table-top", ".table-stage", ".table-dashboard", ".character-portrait", ".dialogue", ".opponent-hand", ".player-zone .cards", ".action-dock"
  ].map(selector => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return [selector, { x, y, width, height }];
  })));
}

/** Uses the production tutorial controller/API and native showModal(), with an isolated tutorial lifetime. */
async function showTutorial(page: Page, presentation: "popover" | "modal"): Promise<void> {
  await page.evaluate(async presentation => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { TutorialController } = await load("/src/presentation/tutorial-controller.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const repository = createPersistenceService();
    const save = { ...await repository.loadLongTerm(), skipTutorial: false };
    const controller = new TutorialController({ root: document.querySelector<HTMLDivElement>("#app")!, save,
      repository, autosave: null, enqueueNotification() {} });
    const lifetime = new AbortController();
    controller.setReady();
    const cancel = controller.forPackage("example/achievement-toast", lifetime.signal).show({
      id: `simultaneous-${presentation}`, title: "牌桌操作教程", presentation, autoSkipMs: null,
      pages: [{ body: "这是一条通过真实教程接口显示的中性说明。成就提示出现时，教程继续保留。" }]
    }, { replay: true });
    (window as any).__achievementTutorial = { controller, lifetime, cancel };
  }, presentation);
  await page.clock.runFor(32);
  await expect(page.locator("#tutorial-popover")).toBeVisible();
  if (presentation === "modal") expect(await page.locator("#tutorial-popover").evaluate(element => element.matches(":modal"))).toBe(true);
}

async function clearTutorial(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as any).__achievementTutorial;
    probe?.cancel(); probe?.lifetime.abort(); probe?.controller.dispose();
  });
  await page.clock.runFor(32);
}

async function assertToastPaintsAboveTutorial(page: Page): Promise<void> {
  const above = await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>(".achievement-toast")!;
    const region = document.querySelector<HTMLElement>(".achievement-toast-region")!;
    const previous = [region.style.pointerEvents, toast.style.pointerEvents];
    try {
      // The normal noninteractive popup intentionally does not participate in hit testing.
      region.style.pointerEvents = "auto"; toast.style.pointerEvents = "auto";
      const rect = toast.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return top === toast || !!top && toast.contains(top);
    } finally { region.style.pointerEvents = previous[0]; toast.style.pointerEvents = previous[1]; }
  });
  expect(above).toBe(true);
}

async function assertToastInAccessibilityTree(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", {});
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".achievement-toast-region" });
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
    const status = nodes.find(item => item.backendDOMNodeId === node.backendNodeId);
    expect(status?.ignored).toBe(false);
    expect(status?.role?.value).toBe("status");
    expect(nodes.some(item => !item.ignored && item.name?.value === "好运眷顾")).toBe(true);
  } finally { await cdp.detach(); }
}

for (const viewport of viewports) {
  test(`三秒浮层和生命周期条不改变牌桌布局，记录恢复不重播 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountFixture(page, { table: true, observations: 2 });
    await freezeClock(page);
    await expect.poll(() => page.locator(".character-portrait").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const before = await tableGeometry(page);
    await observe(page);
    await page.clock.runFor(32);
    const toast = page.locator(".achievement-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("好运眷顾");
    expect(await tableGeometry(page)).toEqual(before);
    const geometry = await toast.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const overlaps = [".action-dock", ".player-zone .cards", ".opponent-hand"].filter(selector => {
        const target = document.querySelector(selector)!.getBoundingClientRect();
        return rect.left < target.right && rect.right > target.left && rect.top < target.bottom && rect.bottom > target.top;
      });
      return { fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, overlaps };
    });
    expect(geometry).toEqual({ fits: true, overlaps: [] });
    expect(await progress(page)).toBeLessThan(.06);
    await page.clock.runFor(1200);
    expect(await progress(page)).toBeGreaterThan(.35);
    expect(await progress(page)).toBeLessThan(.5);
    await page.screenshot({ path: `${screenshotDirectory}/unlock-table-${viewport.width}.png` });
    await page.evaluate(async () => { const { service } = (window as any).__achievementUiFixture; await service.submit(service.checkpoint.ledger); });
    await page.clock.runFor(1700);
    await expect(toast).toContainText("好运眷顾");
    expect(await progress(page)).toBeGreaterThan(.9);
    await page.clock.runFor(100);
    await expect(toast).toHaveCount(0);
    expect(await tableGeometry(page)).toEqual(before);
    await page.clock.resume();
    await mountFixture(page, { observations: 0 });
    await expect(toast).toHaveCount(0);
    await page.locator('[data-ui-action="achievements"]').click();
    await expect(page.locator(".achievement-overview .is-completed[data-achievement-key]")).toHaveCount(3);
  });
}

for (const scenario of ["popover-before", "modal-before", "modal-after"] as const) {
  test(`真实教程与成就立即同时显示，浮层在上且保持焦点及可访问性 ${scenario}`, async ({ page }) => {
    await mountFixture(page, { table: true, observations: 2 });
    await freezeClock(page);
    if (scenario !== "modal-after") await showTutorial(page, scenario === "popover-before" ? "popover" : "modal");
    const before = await page.evaluate(() => { (window as any).__achievementFocusBefore = document.activeElement; return true; });
    expect(before).toBe(true);
    await observe(page);
    await page.clock.runFor(32);
    const toast = page.locator(".achievement-toast");
    await expect(toast).toContainText("好运眷顾");
    if (scenario === "modal-after") await showTutorial(page, "modal");
    else expect(await page.evaluate(() => document.activeElement === (window as any).__achievementFocusBefore)).toBe(true);
    await expect(page.locator("#tutorial-popover")).toBeVisible();
    await expect(toast).toBeVisible();
    await assertToastPaintsAboveTutorial(page);
    await assertToastInAccessibilityTree(page);
    if (scenario !== "popover-before") await expect(page.locator("#tutorial-popover [data-tutorial-next]")).toBeFocused();
    await page.clock.runFor(900);
    await page.screenshot({ path: `${screenshotDirectory}/toast-tutorial-${scenario}-390.png` });
    await page.clock.runFor(2200);
    await expect(toast).toHaveCount(0);
    await expect(page.locator("#tutorial-popover")).toBeVisible();
    await clearTutorial(page);
  });
}

test("最多三张各自计时，后来的卡片不被先到期卡片取消", async ({ page }) => {
  await mountFixture(page, { observations: 0 }); await freezeClock(page);
  await observe(page); await page.clock.runFor(1000);
  await observe(page, "2026-11-10T08:31:00Z"); await page.clock.runFor(1000);
  await observe(page, "2026-11-10T08:32:00Z"); await page.clock.runFor(32);
  const toast = page.locator('.achievement-toast');
  await expect(toast).toHaveCount(3);
  const boxes = await toast.evaluateAll(items => items.map(el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom};}));
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].bottom);
  expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].bottom);
  await page.clock.runFor(1000); await expect(toast).toHaveCount(2);
  await expect(toast.first()).toContainText('沉着应对');
  await page.clock.runFor(1000); await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('好运眷顾');
  await page.clock.runFor(1000); await expect(toast).toHaveCount(0);
});

test("后台隐藏并暂停生命周期，恢复继续剩余时间且不会重置进度", async ({ page }) => {
  await mountFixture(page, { observations: 0 });
  await freezeClock(page);
  await observe(page);
  await page.clock.runFor(1000);
  const toast = page.locator(".achievement-toast");
  const elapsed = await progress(page);
  expect(elapsed).toBeGreaterThan(.25);
  expect(elapsed).toBeLessThan(.4);
  await setForeground(page, false);
  await expect(toast).not.toBeVisible();
  await page.clock.runFor(10_000);
  await setForeground(page, true);
  await expect(toast).toContainText("初露锋芒");
  expect(await progress(page)).toBeGreaterThanOrEqual(elapsed);
  expect(await progress(page)).toBeLessThan(elapsed + .06);
  await page.clock.runFor(1750);
  await expect(toast).toBeVisible();
  await page.clock.runFor(300);
  await expect(toast).toHaveCount(0);
});

test("当前和排队提示跟随最新目录媒体，停用清除且重新启用不重播", async ({ page }) => {
  await mountFixture(page, { observations: 0 });
  await freezeClock(page);
  await observe(page);
  await page.clock.runFor(32);
  const expectedUrl = await page.evaluate(async () => {
    const fixture = (window as any).__achievementUiFixture;
    const nextUrl = fixture.entries[1].coverUrl;
    fixture.entries = fixture.entries.map((item: any, index: number) => index ? item : { ...item,
      definition: { ...item.definition, name: "更新后的初露锋芒" }, coverUrl: nextUrl });
    const { installAchievementUiCatalog } = await import(/* @vite-ignore */ "/src/runtime/achievement-ui.ts");
    installAchievementUiCatalog(fixture.entries);
    return nextUrl;
  });
  await page.clock.runFor(32);
  const toast = page.locator(".achievement-toast");
  await expect(toast).toContainText("更新后的初露锋芒");
  await expect(toast.locator("img")).toHaveAttribute("src", expectedUrl);
  await observe(page, "2026-11-10T08:31:00Z");
  await observe(page, "2026-11-10T08:32:00Z");
  await page.evaluate(async () => {
    const { installAchievementUiCatalog } = await import(/* @vite-ignore */ "/src/runtime/achievement-ui.ts");
    installAchievementUiCatalog([]);
  });
  await page.clock.runFor(32);
  await expect(toast).toHaveCount(0);
  await page.evaluate(async () => {
    const { entries } = (window as any).__achievementUiFixture;
    const { installAchievementUiCatalog } = await import(/* @vite-ignore */ "/src/runtime/achievement-ui.ts");
    installAchievementUiCatalog(entries);
  });
  await page.clock.runFor(10_000);
  await expect(toast).toHaveCount(0);
  await page.locator('[data-ui-action="achievements"]').click();
  await expect(page.locator(".achievement-overview .is-completed[data-achievement-key]")).toHaveCount(3);
});

test("静音不输出解锁声音，有声每项只调度一次且恢复和重绘不重播", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { buffers: [] as number[], media: [] as string[] };
    (window as any).__achievementAudioProbe = probe;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      probe.buffers.push(this.buffer?.duration ?? 0);
      return start.apply(this, args);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const source = this.currentSrc || this.src;
      if (source.includes("achievement-unlock")) probe.media.push(source);
      return play.call(this);
    };
  });
  await mountFixture(page, { observations: 0 });
  await freezeClock(page);
  const outputs = () => page.evaluate(() => {
    const probe = (window as any).__achievementAudioProbe;
    return { count: probe.buffers.length + probe.media.length, buffers: probe.buffers, media: probe.media };
  });
  await observe(page);
  await page.clock.runFor(3100);
  expect((await outputs()).count).toBe(0);
  await page.mouse.click(15, 200);
  await page.evaluate(async () => {
    const { gameAudio } = await import(/* @vite-ignore */ "/src/audio/game-audio.ts");
    gameAudio.configure(true, 0);
  });
  await observe(page, "2026-11-10T08:31:00Z");
  await page.clock.runFor(32);
  await expect.poll(async () => (await outputs()).count).toBe(1);
  await page.evaluate(async () => {
    const { service } = (window as any).__achievementUiFixture;
    await service.submit(service.checkpoint.ledger);
    window.dispatchEvent(new Event("resize"));
  });
  await page.clock.runFor(200);
  await setForeground(page, false);
  await page.clock.runFor(1000);
  await setForeground(page, true);
  expect((await outputs()).count).toBe(1);
  await page.clock.runFor(3100);
  await observe(page, "2026-11-10T08:32:00Z");
  await page.clock.runFor(32);
  await expect.poll(async () => (await outputs()).count).toBe(2);
  const output = await outputs();
  expect(output.buffers.every((duration: number) => duration > 0 && duration < 2)).toBe(true);
});

for (const viewport of viewports) {
test(`前两项独立，第三项名字加N汇总，关闭分组不撤销记录 ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await mountFixture(page, { observations: 0 }); await freezeClock(page);
  const entry = page.locator('[data-ui-action="achievements"]'); await entry.focus();
  for (let i = 0; i < 10; i++) await observe(page, `2026-11-10T08:${String(i).padStart(2,'0')}:00Z`);
  await page.clock.runFor(1000);
  const toast = page.locator('.achievement-toast');
  await expect(toast).toHaveCount(3);
  await expect(toast.nth(0)).toContainText('初露锋芒');
  await expect(toast.nth(1)).toContainText('沉着应对');
  await expect(toast.nth(2)).toContainText('好运眷顾');
  await expect(toast.nth(2)).toContainText('+2');
  expect((await toast.first().boundingBox())!.x).toBe(Math.max(10, (viewport.width - 470) / 2 + 10));
  await expect(entry).toBeFocused();
  await page.screenshot({ path: `${screenshotDirectory}/three-aggregate-${viewport.width}.png` });
  await page.evaluate(() => {
    const f = (window as any).__achievementUiFixture;
    f.service.installCatalog(f.entries.map((e: any) => e.definition.id === 'lucky-break' ? { ...e, definition: { ...e.definition, name: '用于验证长成就名称不会遮住汇总数量的中性测试'.repeat(2) } } : e));
  });
  await page.clock.runFor(32);
  const count = await toast.last().locator('.achievement-toast-more').boundingBox();
  const heading = await toast.last().locator('strong').boundingBox();
  expect(count!.x + count!.width).toBeLessThanOrEqual(heading!.x + heading!.width + 1);
  await expect(toast.last()).toContainText('+2');

  await toast.nth(1).getByRole('button', { name: '关闭当前成就提示' }).click();
  await page.clock.runFor(32); await expect(toast).toHaveCount(2);
  await expect(entry).toBeFocused();
  await toast.last().getByRole('button', { name: '关闭当前成就提示' }).focus();
  await page.keyboard.press('Enter'); await page.clock.runFor(32);
  await expect(toast).toHaveCount(1); await expect(toast).toContainText('初露锋芒');
  await toast.getByRole('button', { name: '关闭当前成就提示' }).click();
  await page.clock.runFor(32); await expect(toast).toHaveCount(0); await expect(entry).toBeFocused();
  await page.clock.runFor(10000); await expect(toast).toHaveCount(0);
  await entry.click(); await expect(page.locator('.achievement-overview .is-completed')).toHaveCount(5);
});

}
