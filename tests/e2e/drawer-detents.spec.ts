import { expect, test, type Locator, type Page } from "@playwright/test";

async function settled(handle: Locator) {
  await expect(handle).toHaveAttribute("data-drawer-state", "settled");
  const value = Number(await handle.getAttribute("data-drawer-position"));
  const stops = (await handle.getAttribute("data-drawer-stops"))!.split(",").map(Number);
  expect(Math.min(...stops.map(stop => Math.abs(stop - value)))).toBeLessThan(.1);
  return { value, stops };
}
async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up();
  return settled(handle);
}
async function mountTable(page: Page) {
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const talent = { id: "example-drawer", name: "抽屉示例", description: "中性夹具", sourceKind: "talent", primaryDomain: "gambler", tags: ["display"], activation: { type: "automatic" }, unlock: { type: "defeat-count", count: 1, label: "示例" }, rules: [],
      displays: Array.from({ length: 12 }, (_, i) => ({ id: `reading-${i}`, target: "owner", description: "示例状态", content: [{ type: "text", text: `状态 ${i + 1}：` }, { type: "number", value: i }] })) };
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, talent], registry.STATUS_DEFINITIONS, registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
    let match = createMatch("neutral-drawer-ui", { opponentId: "chatgpt", talentIds: [talent.id], opponentAiSkills: [], skillDeckIds: [] });
    const cards = Array.from({ length: 4 }, (_, i) => registry.instantiateAbility({ definitionId: "critical-judgment", enabled: true, parameters: {} }, "player", `drawer-card-${i}`, match.abilities.sequence + i + 1, undefined, "player-skill"));
    for (const card of cards) match = { ...match, abilities: addAbilityInstance(match.abilities, card) };
    match = { ...match, playerSkills: { ...match.playerSkills, drawOffer: null, cards: cards.map(card => ({ instanceId: card.instanceId, definitionId: card.definitionId, owner: "player", kind: "player-skill" })) } };
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
  await expect(page.locator("main.table-shell")).toBeVisible();
  await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
}

for (const [width, height] of [[390, 844], [320, 720], [1280, 800]]) test(`固定资源面板与技能吸附、键盘和触屏 ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  const resources = page.locator("[data-package-drawer]");
  await expect(resources).toBeVisible();
  await expect(resources.getByRole("slider")).toHaveCount(0);
  const originalHeight = (await resources.boundingBox())!.height;
  expect(originalHeight).toBeCloseTo(Math.min(height * .88, 760), 0);
  const list = page.locator(".package-list");
  await list.hover(); await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const scrollTop = await list.evaluate(el => el.scrollTop);
  const previousList = await list.elementHandle();
  await page.locator("[data-retry-packages]").click();
  await expect.poll(() => previousList!.evaluate(el => el.isConnected)).toBe(false);
  await expect(resources).toBeVisible();
  await expect(list).toHaveJSProperty("scrollTop", scrollTop);
  expect((await resources.boundingBox())!.height).toBe(originalHeight);
  await page.screenshot({ path: info.outputPath(`resources-${width}.png`) });
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-open-packages]").click();
  await expect(resources).toBeVisible();
  expect((await resources.boundingBox())!.height).toBe(originalHeight);
  await expect(list).toHaveJSProperty("scrollTop", scrollTop);
  await page.keyboard.press("Escape");
  await expect(resources).not.toBeVisible();
  await mountTable(page);
  const skills = page.locator(".skill-drawer-toggle");
  await settled(skills); await skills.focus(); await page.keyboard.press("ArrowLeft");
  let first = await settled(skills); expect(first.value).toBe(first.stops[1]);
  await expect(page.locator(".skill-tile").first()).not.toHaveJSProperty("inert", true);
  await expect(page.locator(".skill-tile").nth(1)).toHaveJSProperty("inert", true);
  await page.screenshot({ path: info.outputPath(`skills-one-column-${width}.png`) });
  const moved = await drag(page, skills, -45, 0); expect(moved.value).toBe(moved.stops.at(-1));
  const limitGrip = (await skills.boundingBox())!;
  const sx = limitGrip.x + limitGrip.width / 2, sy = limitGrip.y + limitGrip.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx - 100, sy, { steps: 8 });
  const elastic = Number(await skills.getAttribute("data-drawer-position"));
  expect(elastic).toBeGreaterThan(moved.value); expect(elastic).toBeLessThan(moved.value + 26);
  await page.mouse.up(); expect((await settled(skills)).value).toBe(moved.value);
  // Re-rendering after a real skill use retains the selected column detent.
  await skills.focus(); await page.keyboard.press("ArrowRight"); first = await settled(skills);
  await page.locator('[data-skill-id="critical-judgment"]').first().click();
  await expect.poll(async () => (await settled(skills)).value).toBe(first.value);
  await skills.focus(); await page.keyboard.press("Home"); await settled(skills);
  const closed = (await skills.boundingBox())!;
  await page.mouse.move(closed.x + closed.width / 2, closed.y + closed.height / 2); await page.mouse.down();
  await page.mouse.move(closed.x + closed.width / 2 + 60, closed.y + closed.height / 2, { steps: 8 });
  expect((await skills.boundingBox())!.x).toBeGreaterThan(closed.x);
  await page.mouse.up(); await settled(skills);
  const touch = await page.context().newCDPSession(page);
  const box = (await skills.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 90 * i / 8, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach();
  expect((await settled(skills)).value).toBe(first.value);
  // Information stays expanded; only the skill panel uses detents.
  await expect(page.locator("[data-display-toggle]")).toHaveCount(0);
  const scroller = page.locator(".display-scroll");
  await scroller.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath(`displays-${width}.png`) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await skills.focus(); await page.keyboard.press("Home");
  expect((await settled(skills)).value).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("隐藏弹窗首次测量为零时仍保持收起，释放后停止响应", async ({ page }) => {
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const { createDetentDrawer } = await import(/* @vite-ignore */ "/src/presentation/detent-drawer.ts");
    const dialog = document.createElement("dialog");
    dialog.innerHTML = '<button id="neutral-drawer-handle">内容把手</button><div style="width:200px;height:100px"></div>';
    document.body.append(dialog);
    const handle = dialog.querySelector<HTMLElement>("button")!;
    const content = dialog.querySelector<HTMLElement>("div")!;
    const drawer = createDetentDrawer({ handle, axis: "x", direction: -1, stops: () => [0, content.offsetWidth / 2, content.offsetWidth], observe: [content], render: () => {} });
    (window as any).disposeExampleDrawer = () => drawer.dispose();
    dialog.showModal();
  });
  const handle = page.locator("#neutral-drawer-handle");
  await expect(handle).toHaveAttribute("data-drawer-stops", "0,100,200");
  await expect(handle).toHaveAttribute("data-drawer-position", "0");
  await handle.press("ArrowLeft"); await settled(handle);
  await expect(handle).toHaveAttribute("data-drawer-position", "100");
  await page.evaluate(() => (window as any).disposeExampleDrawer());
  await handle.press("End"); await expect(handle).toHaveAttribute("data-drawer-position", "100");
});
