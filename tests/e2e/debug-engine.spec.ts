import { expect, test as base, type Page } from "@playwright/test";

const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await use();
    expect(errors).toEqual([]);
  }, { auto: true }]
});

async function launcher(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
}
async function enterLobby(page: Page): Promise<void> {
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("#adult-content-warning, [data-app-version]").waitFor({ state: "visible" });
  const warning = page.locator("#adult-content-warning");
  if (await warning.isVisible()) await warning.getByRole("button", { name: "我已成年并继续" }).click();
  await expect(page.locator("[data-app-version]")).toBeVisible();
}
async function taps(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await page.locator("[data-app-version]").click();
}
async function runtime(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await (await load("/src/persistence/factory.ts")).createPersistenceService().loadRuntime())?.activeMatch;
  });
}
async function mountMatch(page: Page, actor = "player"): Promise<void> {
  await launcher(page);
  await page.evaluate(async actor => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
    await bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const base = createMatch("debug-ui", { opponentId: "chatgpt", intrinsicAbilities: [{ definitionId: "builtin-debug-control", enabled: true, parameters: {} }], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", i === 0 || i === 2 ? "10" : i === 1 ? "7" : i === 3 ? "8" : "2", `debug-ui-${i}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], round: { ...base.round, player, opponent, phase: "turns", currentActor: actor, outcome: null } };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    save.settings.debugEngineEnabled = true; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repository = createPersistenceService();
    await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));
  }, actor);
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await expect(page.locator("[data-debug-handle]")).toBeVisible();
}
async function drag(page: Page, selector: string, dy: number): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test("version gate resets on timeout, supports cancellation and persists confirmed activation", async ({ page }, testInfo) => {
  await launcher(page); await enterLobby(page);
  await expect(page.locator("[data-debug-handle]")).toBeHidden();
  await taps(page, 4);
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await page.waitForTimeout(1100);
  await taps(page, 1);
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await taps(page, 4);
  const dialog = page.locator("[data-game-dialog]");
  await expect(dialog).toHaveCount(1);
  await expect(dialog.locator("[data-game-dialog-message]")).toHaveText("开启调试引擎会极大影响游戏寿命，是否确认开启");
  await page.screenshot({ path: testInfo.outputPath("debug-confirmation-390.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("[data-debug-handle]")).toBeHidden();
  await taps(page, 5);
  await dialog.getByRole("button", { name: "确认开启", exact: true }).click();
  await expect(page.locator("[data-debug-handle]")).toBeVisible();
  await page.locator("[data-debug-handle]").click();
  await expect(page.locator("[data-debug-field] button:enabled")).toHaveCount(0);
  await page.reload(); await enterLobby(page);
  await expect(page.locator("[data-debug-handle]")).toBeVisible();
  await expect(page.locator(".dev-hud")).toHaveCount(0);
});

test("five controls update real game state, survive reload, and fit both phone sizes", async ({ page }, testInfo) => {
  await mountMatch(page);
  await page.locator("[data-debug-handle]").click();
  const row = (field: string) => page.locator(`[data-debug-field="${field}"]`);
  await row("playerAdvantage").getByRole("button", { name: "玩家点数优势增加10", exact: true }).click();
  await row("aiAdvantage").getByRole("button", { name: "AI 点数优势减少1", exact: true }).click();
  await row("publicBustLimit").getByRole("button", { name: "公共爆牌上限增加1", exact: true }).click();
  await row("playerBullets").getByRole("button", { name: "玩家左轮装填数增加10", exact: true }).click();
  await row("playerBullets").getByRole("button", { name: "玩家左轮装填数减少1", exact: true }).click();
  await row("aiBullets").getByRole("button", { name: "AI 左轮装填数增加1", exact: true }).click();
  for (const [field, value] of [["playerAdvantage", "10"], ["aiAdvantage", "-1"], ["publicBustLimit", "22"], ["playerBullets", "5"], ["aiBullets", "1"]]) {
    await expect(row(field).locator("output")).toHaveText(value);
  }
  await expect.poll(async () => (await runtime(page))?.roulette.player.bullets).toBe(5);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const buttons = await page.locator("[data-debug-field] button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).every(box => box.x >= 0 && box.right <= innerWidth));
    expect(buttons).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`debug-panel-${width}.png`) });
  }
  await page.locator("[data-debug-close]").click();
  await expect(page.locator(".player-zone .hand-score")).toContainText("+10");
  await expect(page.locator(".bust-limit-indicator strong")).toHaveText("22");
  await page.screenshot({ path: testInfo.outputPath("debug-table-320.png") });
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await page.locator("[data-debug-handle]").click();
  await expect(row("playerAdvantage").locator("output")).toHaveText("10");
  await expect(row("publicBustLimit").locator("output")).toHaveText("22");
  await expect(row("playerBullets").locator("output")).toHaveText("5");
  await expect(page.locator(".dev-hud")).toHaveCount(0);
});

test("top gestures open and close, and the panel pauses then resumes automatic AI", async ({ page }) => {
  await mountMatch(page, "opponent");
  await drag(page, "[data-debug-handle]", 90);
  await expect(page.locator("#debug-engine-panel")).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const before = await runtime(page);
  await page.clock.runFor(5000);
  expect((await runtime(page)).history).toEqual(before.history);
  await drag(page, "#debug-engine-panel header", -70);
  await expect(page.locator("#debug-engine-panel")).toBeHidden();
  await page.clock.runFor(5000);
  await expect.poll(async () => (await runtime(page))?.history.some((event: any) => event.type === "AI_DECISION")).toBe(true);
});

test("disabling removes continuous effects but preserves bullet edits and persists the disabled toggle", async ({ page }) => {
  await mountMatch(page);
  await page.locator("[data-debug-handle]").click();
  await page.getByRole("button", { name: "玩家点数优势增加10", exact: true }).click();
  await page.getByRole("button", { name: "公共爆牌上限增加10", exact: true }).click();
  await page.getByRole("button", { name: "玩家左轮装填数增加1", exact: true }).click();
  const retainedAbilities = (await runtime(page)).abilities.instances.filter((instance: any) => instance.definitionId !== "builtin-debug-control");
  await page.locator("[data-debug-disable]").click();
  await expect(page.locator("[data-debug-handle]")).toBeHidden();
  await expect(page.locator(".player-zone .hand-score")).not.toContainText("+10");
  await expect(page.locator(".bust-limit-indicator strong")).toHaveText("21");
  await expect.poll(async () => (await runtime(page))?.abilities.instances.some((instance: any) => instance.definitionId === "builtin-debug-control")).toBe(false);
  expect((await runtime(page)).abilities.instances).toEqual(retainedAbilities);
  expect((await runtime(page)).roulette.player.bullets).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await expect(page.locator("[data-debug-handle]")).toBeHidden();
});

test("native touch drag works and lowered limits update bust flags immediately", async ({ page }) => {
  await mountMatch(page);
  const session = await page.context().newCDPSession(page);
  const touchDrag = async (selector: string, distance: number) => {
    const box = (await page.locator(selector).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await touchDrag("[data-debug-handle]", 90);
  await expect(page.locator("#debug-engine-panel")).toBeVisible();
  await page.getByRole("button", { name: "公共爆牌上限减少10", exact: true }).click();
  await expect.poll(async () => (await runtime(page))?.player.busted).toBe(true);
  await page.getByRole("button", { name: "公共爆牌上限增加10", exact: true }).click();
  await expect.poll(async () => (await runtime(page))?.player.busted).toBe(false);
  await touchDrag("#debug-engine-panel header", -70);
  await expect(page.locator("#debug-engine-panel")).toBeHidden();
  await page.locator("[data-debug-handle]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#debug-engine-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#debug-engine-panel")).toBeHidden();
  await expect(page.locator("[data-debug-handle]")).toBeFocused();
  await session.detach();
});

test("official plugin is imported once and disabling or removing it removes the entry and continuous effects", async ({ page }, testInfo) => {
  await mountMatch(page);
  await page.locator("[data-debug-handle]").click();
  await page.getByRole("button", { name: "玩家点数优势增加10", exact: true }).click();
  await page.getByRole("button", { name: "公共爆牌上限减少10", exact: true }).click();
  await page.getByRole("button", { name: "玩家左轮装填数增加1", exact: true }).click();
  await expect.poll(async () => (await runtime(page))?.roulette.player.bullets).toBe(1);
  const retainedAbilities = (await runtime(page)).abilities.instances.filter((instance: any) => instance.definitionId !== "builtin-debug-control");
  await page.reload();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  const card = page.locator('.package-card[data-package-id="hoc-core/debug-engine"]');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-package-state", "enabled");
  await card.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await page.screenshot({ path: testInfo.outputPath("debug-official-plugin.png") });
  await page.getByRole("button", { name: "关闭资源管理", exact: true }).click();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await expect(page.locator("[data-debug-handle]")).toHaveCount(0);
  await expect(page.locator(".bust-limit-indicator strong")).toHaveText("21");
  await expect.poll(async () => (await runtime(page))?.abilities.instances.some((instance: any) => instance.definitionId === "builtin-debug-control")).toBe(false);
  expect((await runtime(page)).abilities.instances).toEqual(retainedAbilities);
  expect((await runtime(page)).roulette.player.bullets).toBe(1);
  expect((await runtime(page)).player.busted).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await card.getByRole("button", { name: "删除", exact: true }).click();
  await page.locator("[data-game-dialog]").getByRole("button", { name: "删除", exact: true }).click();
  await expect(card).toHaveAttribute("data-package-state", "not-installed");
  await page.reload();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await expect(card).toHaveAttribute("data-package-state", "not-installed");
});

test("disabled plugin does not handle version clicks or expose its hidden toggle in settings", async ({ page }) => {
  await launcher(page);
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('.package-card[data-package-id="hoc-core/debug-engine"] [data-package-action="disable"]').click();
  await page.getByRole("button", { name: "关闭资源管理", exact: true }).click();
  await enterLobby(page);
  await taps(page, 5);
  await expect(page.locator("[data-game-dialog]")).toHaveCount(0);
  await expect(page.locator("[data-debug-handle]")).toHaveCount(0);
  await page.locator('[data-open="settings"]').click();
  await expect(page.locator('[data-plugin-setting="enabled"]')).toHaveCount(0);
});
