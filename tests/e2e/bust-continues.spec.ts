import { expect, test, type Page } from "@playwright/test";

async function mountTable(page: Page, options: { motion?: boolean; safe?: boolean; audioProbe?: boolean } = {}) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async options => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
    await bootstrapContent({ fetch: window.fetch.bind(window) });
    const { loadCharacter, installCharacterDefinitions } = await load("/src/content/characters/loader.ts");
    const { installCharacterCatalog } = await load("/src/content/characters/catalog.ts");
    const character = await loadCharacter("chatgpt");
    const neutral = { ...character, id: "example-bust-table", name: "示例对手", aiSkills: [], unlock: undefined,
      dialogue: { ...character.dialogue, pools: Object.fromEntries(Object.keys(character.dialogue.pools).map(id => [id, [id === "PUSH_ROUND" ? "双方爆牌，本轮平局。" : "示例牌局，继续行动。"]])) } };
    installCharacterCatalog([{ id: neutral.id, name: neutral.name, subtitle: "中性牌局验证", tier: "D", tags: [], previewImage: "/assets/package-cover-fallback.png", portraitScales: neutral.portraitScales }], neutral.id);
    installCharacterDefinitions([neutral]);
    const { ABILITY_REGISTRY, installAbilityRegistry } = await load("/src/core/abilities/registry.ts");
    const advantage = { id: "example-table-advantage", name: "示例优势", description: "中性点数优势", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "points", trigger: "before-round-resolution", conditions: [{ type: "round-reason-is", value: "comparison" }], effects: [{ type: "add-to-pending-comparison-score", target: "rival", amount: 3 }] }] };
    installAbilityRegistry([...ABILITY_REGISTRY.definitions, advantage], ABILITY_REGISTRY.statuses, ABILITY_REGISTRY.catalogVersion);
    const { createMatch, normalizeAbilityHands } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const base = createMatch("example-bust-table", { opponentId: neutral.id, opponentAiSkills: [{ definitionId: advantage.id, enabled: true, parameters: {} }] });
    const ranks = options.safe ? [...Array(10).fill("A"), "5", "5"] : ["10", "2", ...Array(10).fill("A")];
    const playerCards = ranks.map((rank, i) => createCard("spades", rank, `example-player-${i}`));
    const opponentCards = ["10", "2", ...Array(10).fill("A")].map((rank, i) => createCard("hearts", rank, `example-opponent-${i}`));
    const used = [...playerCards, ...opponentCards];
    const cards = [...used, ...Array.from({ length: 28 }, (_, i) => createCard("clubs", "2", `example-shoe-${i}`))];
    const player = { ...base.player, hand: { cards: playerCards }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: opponentCards }, stood: true, busted: false, bustLimit: undefined };
    const match = normalizeAbilityHands({ ...base, player, opponent, shoe: { cards, cursor: used.length, shuffleIndex: 1 },
      playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, phase: "turns", currentActor: "player", player, opponent, outcome: null },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }, ...used.map((card, i) => ({ type: "CARD_DEALT", actor: i < playerCards.length ? "player" : "opponent", card, private: true }))] });
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = !options.motion;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repository = createPersistenceService();
    await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));
    if (options.audioProbe) {
      const { gameAudio } = await load("/src/audio/game-audio.ts");
      (window as any).__roundAudio = [];
      gameAudio.play = (cue: string, delayMs = 0) => { (window as any).__roundAudio.push([cue, delayMs]); };
    }
    (window as any).__testRuntimeHandle = await mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, options);
  await expect(page.locator('[data-hand-scroll="player"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Hit 要牌", exact: true })).toBeEnabled();
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 1280, height: 900 }]) {
  test(`基础点数特效与双方爆牌结算 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { motion: true });
    const base = page.locator(".player-zone .hand-score-base");
    const modifier = page.locator(".player-zone .hand-score-modifier");
    await expect(base).toHaveText("22");
    await expect(base).toHaveClass(/is-busted/);
    await expect(base).toHaveCSS("color", "rgb(255, 100, 124)");
    await expect(base).toHaveCSS("animation-name", "hand-score-tremble");
    await expect(modifier).toHaveText("+3");
    const appearance = await modifier.evaluate(e => ({ color: getComputedStyle(e).color, animation: getComputedStyle(e).animationName, transform: getComputedStyle(e).transform }));
    expect(appearance.color).not.toBe("rgb(255, 100, 124)");
    expect(appearance.animation).toBe("none");
    expect(appearance.transform).toBe("none");
    await expect(page.locator(".opponent-hand .hand-score-base")).not.toHaveClass(/is-busted/);
    await expect(page.locator(".opponent-hand .card-back")).toHaveCount(11);
    await page.screenshot({ path: testInfo.outputPath(`bust-playing-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(page.locator(".player-zone .card")).toHaveCount(13);
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "turns");
    await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
    await expect(page.locator(".opponent-hand .hand-score-base")).toHaveClass(/is-busted/);
    await expect(page.locator(".opponent-hand .card-back")).toHaveCount(0);
    await expect(page.locator("#dialogue-text")).toHaveText("双方爆牌，本轮平局。");
    await expect(page.locator(".round-notice")).toContainText("平局");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bust-push-${viewport.width}.png`) });
  });

  test(`横向滑动、末尾跟随与新轮重置 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page);
    const player = page.locator('[data-hand-scroll="player"]'), opponent = page.locator('[data-hand-scroll="opponent"]');
    expect(await player.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
    await player.focus();
    await page.keyboard.press("End");
    await expect.poll(() => player.evaluate(e => e.scrollWidth - e.clientWidth - e.scrollLeft)).toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(page.locator(".player-zone .card")).toHaveCount(13);
    await expect.poll(() => player.evaluate(e => e.scrollWidth - e.clientWidth - e.scrollLeft)).toBeLessThanOrEqual(4);
    await player.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
    const left = await player.evaluate(e => e.scrollLeft);
    expect(left).toBeGreaterThan(0);
    await opponent.focus(); await page.keyboard.press("End");
    const opponentLeft = await opponent.evaluate(e => e.scrollLeft);
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(page.locator(".player-zone .card")).toHaveCount(14);
    expect(await player.evaluate(e => e.scrollLeft)).toBe(left);
    expect(await opponent.evaluate(e => e.scrollLeft)).toBe(opponentLeft);
    await page.screenshot({ path: testInfo.outputPath(`hand-scroll-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
    expect(await player.evaluate(e => e.scrollLeft)).toBe(left);
    await page.locator("button[data-action*='ACK_ROUND_RESULT']").click();
    await expect(page.locator(".player-zone .card")).toHaveCount(2);
    expect(await player.evaluate(e => e.scrollLeft)).toBe(0);
    expect(await opponent.evaluate(e => e.scrollLeft)).toBe(0);
  });
}

test("点数优势不导致爆牌，减少动态效果关闭颤动", async ({ page }) => {
  await mountTable(page, { safe: true });
  await expect(page.locator(".player-zone .hand-score-base")).toHaveText("20");
  await expect(page.locator(".player-zone .hand-score-modifier")).toHaveText("+3");
  await expect(page.locator(".player-zone .hand-score-base")).not.toHaveClass(/is-busted/);
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  await expect(page.locator(".player-zone .hand-score-base")).toHaveClass(/is-busted/);
  await expect(page.locator(".player-zone .hand-score-base")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".player-zone .hand-score-base")).toHaveCSS("color", "rgb(255, 100, 124)");
});

test("鼠标拖动超过阈值后横滚，取消和重绘释放拖动", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountTable(page);
  const player = page.locator('[data-hand-scroll="player"]');
  const box = (await player.boundingBox())!;
  const x = box.x + box.width - 30, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 4, y);
  expect(await player.evaluate(e => e.scrollLeft)).toBe(0);
  await page.mouse.move(x - 120, y, { steps: 8 });
  await expect(player).toHaveClass(/is-dragging/);
  expect(await player.evaluate(e => e.scrollLeft)).toBeGreaterThan(100);
  await page.mouse.up();
  await expect(player).not.toHaveClass(/is-dragging/);
  await player.focus(); await page.keyboard.press("Home");
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.wheel(120, 0);
  await expect.poll(() => player.evaluate(e => e.scrollLeft)).toBeGreaterThan(50);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 20, y);
  await player.evaluate(e => e.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
  await page.mouse.up();
  await expect(player).not.toHaveClass(/is-dragging/);
});

test("手牌减少后夹紧滚动位置，重绘时取消未完成拖动", async ({ page }) => {
  await mountTable(page);
  const result = await page.evaluate(async () => {
    const { HandScrollController } = await import(/* @vite-ignore */ "/src/presentation/hand-scroll.ts");
    const { createMatch } = await import(/* @vite-ignore */ "/src/core/match/reducer.ts");
    const { createCard } = await import(/* @vite-ignore */ "/src/core/blackjack/card.ts");
    const state = createMatch("scroll-shrink", { opponentAiSkills: [] });
    const host = document.createElement("div");
    const markup = (count: number) => `<div data-hand-scroll="player" style="display:flex;width:180px;overflow:auto">${"<span style='flex:0 0 46px;height:60px'></span>".repeat(count)}</div>`;
    document.body.append(host);
    const controller = new HandScrollController();
    const player = { ...state.player, hand: { cards: Array.from({ length: 12 }, (_, i) => createCard("spades", "2", `shrink-${i}`)) } };
    host.innerHTML = markup(12); controller.mount(host, { ...state, player });
    host.firstElementChild!.scrollLeft = 1000;
    controller.capture();
    host.innerHTML = markup(2); controller.mount(host, { ...state, player: { ...player, hand: { cards: player.hand.cards.slice(0, 2) } } });
    const left = host.firstElementChild!.scrollLeft;
    controller.dispose(); host.remove();
    return left;
  });
  expect(result).toBe(0);
  const player = page.locator('[data-hand-scroll="player"]');
  const box = (await player.boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 20);
  await expect(player).toHaveClass(/is-dragging/);
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator(".player-zone .card")).toHaveCount(13);
  await expect(player).not.toHaveClass(/is-dragging/);
  await page.mouse.up();
});

test("触屏原生横向滑动", async ({ page, context }) => {
  await mountTable(page);
  const element = page.locator('[data-hand-scroll="player"]');
  const box = (await element.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width - 75, y = box.y + 20;
  expect(await element.evaluate((e, point) => e.contains(document.elementFromPoint(point.x, point.y)), { x, y })).toBe(true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - i * 15, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => element.evaluate(e => e.scrollLeft)).toBeGreaterThan(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("途中爆牌只有行动音、双方爆牌没有结果音且恢复不重播", async ({ page }) => {
  await mountTable(page, { audioProbe: true });
  const cues = () => page.evaluate(() => (window as any).__roundAudio);
  expect(await cues()).toEqual([]);
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  expect(await cues()).toEqual([["cardFlip", 0], ["cardFlip", 0]]);
  await page.getByRole("button", { name: "Stand 停牌", exact: true }).click();
  await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
  expect(await cues()).toEqual([["cardFlip", 0], ["cardFlip", 0], ["stand", 0]]);
  await expect.poll(() => page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    return (await createPersistenceService().loadRuntime())?.activeMatch.round.phase;
  })).toBe("round-reveal");
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const repository = createPersistenceService();
    const snapshot = await repository.loadRuntime();
    await (window as any).__testRuntimeHandle.dispose();
    await repository.saveRuntime(snapshot);
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    (window as any).__testRuntimeHandle = await mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
  await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "round-reveal");
  expect(await cues()).toEqual([["cardFlip", 0], ["cardFlip", 0], ["stand", 0]]);
});
