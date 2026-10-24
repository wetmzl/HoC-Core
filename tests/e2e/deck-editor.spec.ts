import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshots = resolve(process.env.DECK_SCREENSHOT_DIR ?? "output/deck-editor-review");

async function enter(page: Page, count = 10): Promise<string[]> {
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  const ids = await page.evaluate(async (count) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { PLAYER_SKILL_DEFINITIONS } = await load("/src/core/skills/definitions.ts");
    const ids = PLAYER_SKILL_DEFINITIONS.filter((skill: any) => !skill.unlock && skill.drop.enabled && skill.drop.baseWeight > 0).map((skill: any) => skill.id);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true;
    save.settings.soundEnabled = false;
    save.profile.skillDeck = { carried: ids.slice(0, count), reserve: ids.slice(count) };
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
    return ids;
  }, count);
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator("#adult-content-warning")).toBeVisible();
  await page.getByRole("button", { name: "我已成年并继续" }).click();
  await page.locator("[data-open=skills]").click();
  await expect(page.locator(".deck-editor")).toBeVisible();
  return ids;
}

async function savedDeck(page: Page) {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = await (await load("/src/persistence/factory.ts")).createPersistenceService().loadLongTerm();
    return save.profile.skillDeck as { carried: string[]; reserve: string[] };
  });
}
async function point(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`Missing target ${selector}`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function startDrag(page: Page, id: string) {
  await expect(page.locator(".deck-drag-ghost")).toHaveCount(0);
  const start = await point(page, `.deck-grid [data-deck-id="${id}"]`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 5, start.y);
  await expect(page.locator(".deck-drag-ghost")).toBeVisible();
}

test("八组真实截图：小卡、筛选、详情、排序、跨区、落位、下限、窄屏", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  const ids = await enter(page);
  const shot = async (name: string) => { await page.screenshot({ path: resolve(screenshots, name), animations: "disabled" }); };
  await shot("01-overview-390.png");
  await page.locator(".deck-filter summary").click();
  await page.locator("[data-deck-category]").selectOption("active");
  await shot("02-filters-390.png");
  await page.locator("[data-deck-clear]").click();
  await page.locator(".deck-filter summary").click();
  await page.locator(`[data-deck-id="${ids[0]}"]`).click();
  await expect(page.locator(".deck-detail")).toBeVisible();
  await shot("03-detail-390.png");
  await page.locator("[data-deck-detail-close]").click();
  await startDrag(page, ids[0]);
  const target = await point(page, `[data-deck-id="${ids[3]}"]`);
  await page.mouse.move(target.x - 12, target.y);
  await expect(page.locator("[data-deck-zone=carried] .deck-placeholder")).toHaveCount(1);
  await shot("04-reorder-390.png");
  await page.mouse.up();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  const moved = (await savedDeck(page)).carried;
  expect(moved.indexOf(ids[0])).toBeGreaterThan(0);
  await startDrag(page, ids[0]);
  const reserve = await point(page, `[data-deck-grid=reserve] [data-deck-id] >> nth=1`);
  await page.mouse.move(reserve.x - 12, reserve.y);
  await expect(page.locator("[data-deck-zone=reserve]")).toHaveClass(/is-drop-target/);
  await shot("05-cross-zone-390.png");
  await page.mouse.up();
  await expect(page.locator("[data-deck-count]")).toContainText("9 种");
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  await page.waitForTimeout(260);
  await shot("06-dropped-390.png");
  for (const id of (await savedDeck(page)).carried.slice(0, 2)) {
    await page.locator(`[data-deck-id="${id}"]`).click();
    await page.locator("[data-deck-transfer]").click();
    await page.locator("[data-deck-detail-close]").click();
  }
  await expect(page.locator("[data-deck-count]")).toContainText("7 种");
  await page.locator("#skills > [data-close]").click();
  await page.locator("[data-enter-duel]").click();
  await page.locator("[data-invite-character]").first().click();
  await page.locator("[data-profile-start]").click();
  await expect(page.locator("[data-deck-status]")).toContainText("还需加入 1 种");
  await shot("07-minimum-390.png");
  await page.locator(`[data-deck-grid=reserve] [data-deck-id="${ids[0]}"]`).click();
  await page.locator("[data-deck-transfer]").click();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  await page.locator("[data-deck-detail-close]").click();
  await page.setViewportSize({ width: 320, height: 720 });
  await shot("08-overview-320.png");
  const dimensions = await page.locator("[data-deck-grid=carried] .skill-card").first().evaluate((card) => ({ width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height }));
  expect(dimensions).toEqual({ width: 43, height: 66 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("详情操作、两区顺序、刷新恢复与实际存储失败回滚", async ({ page }) => {
  const ids = await enter(page);
  await page.locator(`[data-deck-id="${ids[0]}"]`).click();
  await page.locator("[data-deck-step='1']").click();
  await expect.poll(async () => (await savedDeck(page)).carried[1]).toBe(ids[0]);
  await page.locator("[data-deck-transfer]").click();
  await expect.poll(async () => (await savedDeck(page)).reserve.at(-1)).toBe(ids[0]);
  await page.locator("[data-deck-detail-close]").click();
  const saved = await savedDeck(page);
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("[data-open=skills]").click();
  expect(await page.locator("[data-deck-grid=carried] [data-deck-id]").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.deckId))).toEqual(saved.carried);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value.id === "long-term" && fail) { fail = false; throw new Error("simulated disk full"); }
      return original.call(this, value, key);
    };
  });
  await page.locator(`[data-deck-id="${ids[0]}"]`).click();
  await page.locator("[data-deck-transfer]").click();
  await expect(page.locator("[data-deck-status]")).toContainText("保存失败");
  expect(await savedDeck(page)).toEqual(saved);
  await expect(page.locator("[data-deck-transfer]")).toHaveText("加入卡组");
  await page.locator("[data-deck-transfer]").click();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  expect((await savedDeck(page)).carried.at(-1)).toBe(ids[0]);
});

test("触屏长按跨区、区外取消、减少动态效果与振动去重", async ({ page }) => {
  const patterns: number[][] = [];
  await page.exposeFunction("recordDeckHaptic", (pattern: number[]) => { patterns.push(pattern); return true; });
  await page.addInitScript(() => { Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number | number[]) => { const values = Array.isArray(pattern) ? pattern : [pattern]; if (values.some(Boolean)) void (globalThis as any).recordDeckHaptic(values); return true; } }); });
  const ids = await enter(page);
  const session = await page.context().newCDPSession(page);
  const start = await point(page, `[data-deck-id="${ids[0]}"]`);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await page.waitForTimeout(280);
  await expect(page.locator(".deck-drag-ghost")).toBeVisible();
  const target = await point(page, "[data-deck-grid=reserve] [data-deck-id] >> nth=0");
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x - 12, y: target.y }] });
  await expect(page.locator("[data-deck-zone=reserve]")).toHaveClass(/is-drop-target/);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  expect((await savedDeck(page)).reserve).toContain(ids[0]);
  expect(patterns).toContainEqual([12]);
  expect(patterns).toContainEqual([8]);
  expect(patterns.filter((value) => value[0] === 18)).toHaveLength(1);
  await page.waitForTimeout(400);
  const saved = await savedDeck(page);
  await startDrag(page, ids[1]);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await expect(page.locator(".deck-drag-ghost")).toHaveCount(0);
  expect(await savedDeck(page)).toEqual(saved);
  await page.locator("#skills > [data-close]").click();
  await page.locator("[data-open=settings]").click();
  await page.locator("[data-setting=reducedMotion]").check();
  await page.locator("#settings [data-close]").click();
  await page.locator("[data-open=skills]").click();
  const before = patterns.length;
  await page.locator(`[data-deck-id="${ids[1]}"]`).click();
  await page.locator("[data-deck-transfer]").click();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  await page.waitForTimeout(100);
  expect(patterns.length).toBe(before);
});

test("筛选中排序保留隐藏顺序及新对局候选池快照", async ({ page }) => {
  const ids = await enter(page, 8);
  await page.locator(".deck-filter summary").click();
  await page.locator("[data-deck-category]").selectOption("active");
  const visible = await page.locator("[data-deck-grid=reserve] [data-deck-id]").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.deckId!));
  expect(visible.length).toBeGreaterThan(1);
  const hidden = (await savedDeck(page)).reserve.filter((id) => !visible.includes(id));
  await page.locator(`[data-deck-id="${visible.at(-1)}"]`).click();
  await page.locator("[data-deck-step='-1']").click();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  expect((await savedDeck(page)).reserve.filter((id) => hidden.includes(id))).toEqual(hidden);
  await page.locator("[data-deck-detail-close]").click();
  await page.locator("#skills > [data-close]").click();
  await page.locator("[data-enter-duel]").click();
  await page.locator("[data-invite-character]").first().click();
  await page.locator("[data-profile-start]").click();
  await expect(page.locator(".table-shell")).toBeVisible();
  const snapshot = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await (await load("/src/persistence/factory.ts")).createPersistenceService().loadRuntime()).activeMatch.playerSkills;
  });
  expect(snapshot.deckDefinitionIds).toEqual(ids.slice(0, 8));
  expect(snapshot.selectedSkillTags).toEqual([]);
});

test("空分区双向接收、手势取消及触屏滑动仍使用原生滚动", async ({ page }) => {
  const ids = await enter(page, 0);
  await startDrag(page, ids[0]);
  const empty = await point(page, "[data-deck-grid=carried] .deck-empty");
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.up();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  expect((await savedDeck(page)).carried).toEqual([ids[0]]);
  await startDrag(page, ids[0]);
  const reserve = await point(page, "[data-deck-grid=reserve] [data-deck-id] >> nth=0");
  await page.mouse.move(reserve.x - 12, reserve.y);
  await page.mouse.up();
  await expect.poll(async () => (await savedDeck(page)).carried).toEqual([]);
  await startDrag(page, ids[0]);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".deck-drag-ghost")).toHaveCount(0);
  expect((await savedDeck(page)).carried).toEqual([]);
  await page.locator(".deck-filter summary").click();
  await page.setViewportSize({ width: 320, height: 720 });
  const viewport = page.locator("[data-deck-scroll=reserve]");
  await viewport.scrollIntoViewIfNeeded();
  const card = await point(page, "[data-deck-grid=reserve] [data-deck-id] >> nth=0");
  const session = await page.context().newCDPSession(page);
  const before = await viewport.evaluate((scroll) => scroll.scrollTop);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [card] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: card.x, y: card.y - 60 }] });
  await page.waitForTimeout(20);
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: card.x, y: card.y - 110 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator(".deck-drag-ghost")).toHaveCount(0);
  await expect.poll(() => viewport.evaluate((scroll) => scroll.scrollTop)).toBeGreaterThan(before);
  // Dragging at the card-list edge scrolls that list without committing.
  await page.waitForTimeout(150);
  await viewport.evaluate((scroll) => { scroll.scrollTop = 0; });
  const visibleId = await viewport.evaluate((scroll) => {
    const box = scroll.getBoundingClientRect();
    return Array.from(scroll.querySelectorAll<HTMLElement>("[data-deck-id]")).find((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    })!.dataset.deckId!;
  });
  await startDrag(page, visibleId);
  const scrollBox = (await viewport.boundingBox())!;
  const edgeBefore = await viewport.evaluate((scroll) => scroll.scrollTop);
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height - 5);
  await expect.poll(() => viewport.evaluate((scroll) => scroll.scrollTop)).toBeGreaterThan(edgeBefore);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await savedDeck(page)).carried).toEqual([]);
});

test("中性胜利奖励一键加入后，确认结果仍保留卡组和解锁进度", async ({ page }) => {
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const base = registry.ABILITY_DEFINITIONS.find((definition: any) => definition.sourceKind === "player-skill" && definition.activation.type === "action");
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, { ...base, id: "example-deck-reward", name: "示例奖励技能", unlock: { opponentId: "llama", label: "示例胜利奖励" } }], registry.STATUS_DEFINITIONS, registry.ABILITY_CATALOG_VERSION);
    const { PLAYER_SKILL_DEFINITIONS } = await load("/src/core/skills/definitions.ts");
    const ids = PLAYER_SKILL_DEFINITIONS.filter((skill: any) => !skill.unlock && skill.drop.enabled).map((skill: any) => skill.id);
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const save = createDefaultSave();
    save.profile.skillDeck = { carried: ids.slice(0, 8), reserve: ids.slice(8) };
    save.skipTutorial = true;
    save.settings.soundEnabled = false;
    save.tutorialProgress.completedIds = [(await load("/src/tutorials/tutorials.ts")).ADULT_CONTENT_WARNING_ID];
    const finished = gameReducer(createMatch("deck-reward", { opponentId: "llama", skillDeckIds: ids.slice(0, 8) }), { type: "ESCAPE_MATCH" });
    const victory = { ...finished, outcome: { winner: "player", reason: "opponent-killed" } };
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    await repo.saveLongTerm(save);
    await repo.saveRuntime(createRuntimeSave(victory));
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
  await expect(page.locator("[data-reward-deck=example-deck-reward]")).toBeVisible();
  await page.locator("[data-reward-deck=example-deck-reward]").click();
  await expect(page.locator("[data-reward-deck=example-deck-reward]")).toHaveText("已加入卡组");
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  expect((await savedDeck(page)).carried.at(-1)).toBe("example-deck-reward");
  const progress = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await (await load("/src/persistence/factory.ts")).createPersistenceService().loadLongTerm()).defeats;
  });
  expect(progress.map((record: any) => record.opponentId)).toEqual(["llama"]);
});


for (const width of [390, 320]) test(`大量技能：分区独立滚动、拖到末尾及跨区自动滚动 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  const ids = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const base = registry.ABILITY_DEFINITIONS.find((definition: any) => definition.sourceKind === "player-skill" && definition.activation.type === "action");
    const examples = Array.from({ length: 90 }, (_, index) => ({ ...base, id: `example-scroll-${index}`, name: `滚动示例${index + 1}`, unlock: undefined }));
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, ...examples], registry.STATUS_DEFINITIONS, registry.ABILITY_CATALOG_VERSION);
    const { PLAYER_SKILL_DEFINITIONS } = await load("/src/core/skills/definitions.ts");
    const ids = PLAYER_SKILL_DEFINITIONS.filter((skill: any) => !skill.unlock && skill.drop.enabled).map((skill: any) => skill.id);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.profile.skillDeck = { carried: ids.slice(0, 60), reserve: ids.slice(60) };
    save.skipTutorial = true;
    save.settings.soundEnabled = false;
    save.tutorialProgress.completedIds = [(await load("/src/tutorials/tutorials.ts")).ADULT_CONTENT_WARNING_ID];
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
    return ids;
  });
  await page.locator("[data-open=skills]").click();
  const carried = page.locator("[data-deck-scroll=carried]");
  const reserve = page.locator("[data-deck-scroll=reserve]");
  expect(await carried.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await reserve.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const outerBefore = await page.locator("#skill-content").evaluate((element) => element.scrollTop);
  const box = (await carried.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.wheel(0, 160);
  await expect.poll(() => carried.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await reserve.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.locator("#skill-content").evaluate((element) => element.scrollTop)).toBe(outerBefore);
  await page.waitForTimeout(100);
  await carried.evaluate((element) => { element.scrollTop = 0; });
  await startDrag(page, ids[0]);
  await page.mouse.move(box.x + box.width - 9, box.y + box.height - 9);
  await expect.poll(() => carried.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, `09-carried-scroll-${width}.png`), animations: "disabled" });
  await page.mouse.up();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  expect((await savedDeck(page)).carried.at(-1)).toBe(ids[0]);
  expect(await carried.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  await page.waitForTimeout(250);
  await reserve.scrollIntoViewIfNeeded();
  await startDrag(page, ids[0]);
  const target = (await reserve.boundingBox())!;
  const outerAtDrop = await page.locator("#skill-content").evaluate((element) => element.scrollTop);
  await page.mouse.move(target.x + target.width - 9, target.y + target.height - 9);
  await expect.poll(() => reserve.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  await page.waitForTimeout(100);
  expect(await page.locator("#skill-content").evaluate((element) => element.scrollTop)).toBe(outerAtDrop);
  await page.mouse.up();
  await expect(page.locator("[data-deck-status]")).toHaveText("卡组已保存");
  const saved = await savedDeck(page);
  expect(saved.carried).toHaveLength(59);
  expect(saved.reserve.at(-1)).toBe(ids[0]);
  expect(await reserve.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(screenshots, `10-reserve-scroll-${width}.png`), animations: "disabled" });
});
