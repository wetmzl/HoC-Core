import { expect, test, type Page } from "@playwright/test";

const longLine = "这是一段用于检查滚动阅读的示例台词。".repeat(35);
const viewports = [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 1280, height: 900 }];

async function mountTable(page: Page, options: { text: string; reducedMotion?: boolean; phase?: string; displays?: number; rankBoard?: boolean; debug?: boolean; anchors?: boolean }) {
  await page.goto(options.debug ? "/?debug" : "/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  if (options.reducedMotion === false) await page.clock.install();
  await page.evaluate(async (options) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
    await bootstrapContent({ fetch: window.fetch.bind(window) });
    const { installCharacterCatalog } = await load("/src/content/characters/catalog.ts");
    const { installCharacterDefinitions, loadCharacter } = await load("/src/content/characters/loader.ts");
    // Reuse public neutral artwork; all test identity, abilities and copy are generic.
    const baseCharacter = await loadCharacter("chatgpt");
    const character = { ...baseCharacter, id: "example-table", name: "示例对手", tags: [], unlock: undefined, aiSkills: [],
      portraitScales: { ...baseCharacter.portraitScales, table: options.anchors ? 1.3 : baseCharacter.portraitScales.table },
      tablePortrait: options.anchors ? { anchorY: .92, images: [{ image: baseCharacter.assets.conflicted, anchorY: .82 }] } : baseCharacter.tablePortrait,
      dialogue: { ...baseCharacter.dialogue, pools: Object.fromEntries(Object.keys(baseCharacter.dialogue.pools).map(id => [id, [options.text]])) } };
    installCharacterCatalog([{ id: character.id, name: character.name, subtitle: "布局验证", tier: "D", tags: [],
      previewImage: "/assets/package-cover-fallback.png", portraitScales: character.portraitScales }], character.id);
    installCharacterDefinitions([character]);
    const registry = await load("/src/core/abilities/registry.ts");
    const ai = { id: "example-table-display", name: "示例读数", description: "中性布局夹具", sourceKind: "ai-skill", primaryDomain: "gambler",
      tags: ["display"], activation: { type: "automatic" }, rules: [], displays: Array.from({ length: options.displays ?? 0 }, (_, i) => ({
        id: `value-${i}`, target: "owner", description: "示例状态说明", content: options.rankBoard && i === 0 ? [{ type: "text", text: "记录集合" }, { type: "rank-record", target: "owner", statusDefinitionId: "example-rank-record" }] : [{ type: "text", text: "示例：" }, { type: "number", value: i }]
      })) };
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, ai], [...registry.STATUS_DEFINITIONS, { id: "example-rank-record", defaultDuration: "match", rules: [] }], registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    const base = createMatch("neutral-table-layout", { opponentId: character.id,
      opponentAiSkills: [{ definitionId: ai.id, enabled: true, parameters: {} }] });
    const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", "2", `table-${i}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, bustLimit: undefined };
    const phase = options.phase ?? "turns";
    const match = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
      playerSkills: { ...base.playerSkills, drawCount: 2, drawOffer: null },
      round: { ...base.round, player, opponent, phase, currentActor: phase === "turns" ? "player" : null,
        outcome: phase === "turns" ? null : { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
    save.settings.reducedMotion = options.reducedMotion ?? true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const repo = createPersistenceService();
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void mountGameRuntime({ root: document.querySelector<HTMLElement>("#app")!, onExitRequest: async () => {} });
  }, options);
  await expect(page.locator(".table-bottom")).toBeVisible();
}

async function assertLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const bottom = rect(".table-bottom"), top = rect(".table-top"), bubble = rect(".dialogue"), dock = rect(".action-dock");
    const surface = getComputedStyle(document.querySelector(".table-bottom")!, "::before");
    const surfaceTop = bottom.top + parseFloat(surface.top);
    const portraitBottom = rect(".character-strip").bottom - parseFloat(getComputedStyle(document.querySelector(".character-portrait")!).getPropertyValue("--table-art-rest-bottom"));
    const surfaceFits = Math.abs(bottom.left + parseFloat(surface.left) - rect(".table-shell").left) < 1 && Math.abs(parseFloat(surface.width) - rect(".table-shell").width) < 1 && Math.abs(surfaceTop - portraitBottom) < 1 && Math.abs(surfaceTop + parseFloat(surface.height) - rect(".player-zone .hand-row").bottom) < 1;
    const rows = [".opponent-hand", ".table-notice-row", ".player-zone .hand-row", ".action-dock"].map(rect);
    return { fits: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
      visible: bottom.top >= top.bottom && dock.bottom <= innerHeight,
      dialogueFits: bubble.bottom <= bottom.top && bubble.top >= top.bottom,
      ordered: rows.every((row, i) => i === 0 || rows[i - 1].bottom <= row.top),
      surfaceFits, bottomTop: bottom.top };
  });
  expect(layout.fits).toBe(true);
  expect(layout.visible).toBe(true);
  expect(layout.dialogueFits).toBe(true);
  expect(layout.ordered).toBe(true);
  expect(layout.surfaceFits).toBe(true);
  return layout.bottomTop;
}

for (const viewport of viewports) {
  test(`技能通知对齐真实信息栏顶部 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: "示例对白。", displays: 12 });
    await page.evaluate(async () => {
      const { NotificationController } = await import("/src/presentation/notification-controller.ts");
      const { createDefaultSave } = await import("/src/persistence/boot.ts");
      const notices = new NotificationController({ root: document.querySelector<HTMLDivElement>("#app")!, save: createDefaultSave(), currentCharacter: { name: "示例对手" } as any, offerTutorial: () => {} });
      notices.enqueueAbilityNotices([{ owner: "player", tone: "player", text: "策展人 · 示例技能：获得一张衍生牌" }]);
    });
    const banner = await page.locator("#ability-notices").boundingBox();
    const dashboard = await page.locator(".table-dashboard").boundingBox();
    const menu = await page.locator(".table-top").boundingBox();
    expect(banner!.y).toBeCloseTo(dashboard!.y, 0);
    expect(banner!.y).toBeGreaterThanOrEqual(menu!.y + menu!.height);
    expect(banner!.x).toBeGreaterThanOrEqual(0);
    expect(banner!.x + banner!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath("notifications-top.png") });
  });
}

test("原图身体锚点随思考图及尺寸更新，桌沿静止且人物不裁切", async ({ page }) => {
  await mountTable(page, { text: "示例对白。", anchors: true, phase: "roulette-trigger" });
  const portrait = page.locator(".character-portrait");
  await expect.poll(() => portrait.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const measure = () => page.evaluate(async () => {
    const { imageContentBox } = await import("/src/presentation/character-interaction.ts");
    const image = document.querySelector<HTMLImageElement>(".character-portrait")!;
    const style = getComputedStyle(image), bounds = image.getBoundingClientRect();
    const content = imageContentBox(bounds, image.naturalWidth, image.naturalHeight, style.objectFit, style.objectPosition, image.clientWidth, image.clientHeight)!;
    const bottom = document.querySelector(".table-bottom")!;
    const table = bottom.getBoundingClientRect().top + parseFloat(getComputedStyle(bottom, "::before").top);
    const prop = document.querySelector(".trigger-prop")!;
    return { table, contentTop: content.top, contentHeight: content.height, offset: parseFloat(getComputedStyle(image.closest(".character-strip")!).getPropertyValue("--table-art-anchor-offset")), gunBottom: parseFloat(getComputedStyle(prop).bottom), clipPath: style.clipPath };
  });
  const before = await measure();
  expect(before.contentTop + before.contentHeight * .92).toBeCloseTo(before.table, 1);
  expect(before.clipPath).toBe("none");
  await page.evaluate(async () => {
    const { loadCharacter } = await import("/src/content/characters/loader.ts");
    const character = await loadCharacter("example-table");
    const image = document.querySelector<HTMLImageElement>(".character-portrait")!;
    image.src = character.assets.conflicted;
    await image.decode();
  });
  await expect.poll(async () => (await measure()).offset).toBeGreaterThan(before.offset + 10);
  const thinking = await measure();
  expect(thinking.table).toBeCloseTo(before.table, 1);
  expect(thinking.contentTop + thinking.contentHeight * .82).toBeCloseTo(before.table, 1);
  expect(thinking.gunBottom - before.gunBottom).toBeCloseTo(-(thinking.offset - before.offset), 1);
  await portrait.evaluate((image: HTMLImageElement) => { image.style.width = "200px"; });
  await expect.poll(async () => (await measure()).offset).toBeLessThan(thinking.offset - 1);
  const resized = await measure();
  expect(resized.table).toBeCloseTo(before.table, 1);
  expect(resized.contentTop + resized.contentHeight * .82).toBeCloseTo(before.table, 1);
  expect(resized.clipPath).toBe("none");
});

for (const viewport of viewports) {
  test(`中央通知始终单行且保留完整文字 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: "示例短台词。", phase: "round-reveal" });
    const presentation = page.locator("#presentation");
    await expect(presentation).toHaveText("你胜利·对手装1发·受罚");
    await expect(presentation).toHaveAttribute("data-default", "你胜利·对手装1发·受罚");
    const samples = await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const { roundResultText, triggerResultText } = await load("/src/presentation/round-notice.ts");
      const cases: { label: string; text: string; complete: boolean; truncated?: boolean }[] = [
        { label: "结果未揭晓", text: roundResultText({ round: { outcome: null } }), complete: true },
        { label: "平局", text: roundResultText({ round: { outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }), complete: true },
        { label: "无受罚方", text: roundResultText({ round: { outcome: { winner: "player", reason: "comparison", penaltyTarget: null, bulletsAdded: 0 } } }), complete: true }
      ];
      for (const winner of ["player", "opponent"]) {
        for (const reason of ["comparison", "blackjack", "bust"]) {
          for (const bulletsAdded of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
            for (const cancelled of [false, true]) {
              const outcome = { winner, reason, penaltyTarget: winner === "player" ? "opponent" : "player", bulletsAdded };
              cases.push({ label: `${winner}/${reason}/${bulletsAdded}/${cancelled ? "免罚" : "受罚"}`,
                text: roundResultText({ round: { outcome } }, cancelled), complete: bulletsAdded <= 2 });
            }
          }
        }
      }
      for (const result of ["fired", "misfire", "empty-chamber"]) {
        cases.push({ label: `扳机/${result}`, text: triggerResultText({ type: "TRIGGER_PULLED", result }), complete: true });
      }
      cases.push({ label: "超长通知含换行", text: "示例通知\n第二行\r\n第三行\t" + "长文字与ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(100), complete: false, truncated: true });
      const node = document.querySelector<HTMLElement>("#presentation")!;
      const defaultFontSize = parseFloat(getComputedStyle(node).fontSize);
      const dock = document.querySelector<HTMLElement>(".action-dock")!;
      const originalDock = dock.getBoundingClientRect().toJSON();
      const results = [];
      for (const scale of [1, 2]) {
        node.style.fontSize = `${defaultFontSize * scale}px`;
        for (const sample of cases) {
          node.textContent = sample.text;
          const style = getComputedStyle(node), box = node.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(node);
          const lines = new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top)));
          const currentDock = dock.getBoundingClientRect();
          const rows = [".opponent-hand", ".table-notice-row", ".player-zone .hand-row", ".action-dock"]
            .map(selector => document.querySelector(selector)!.getBoundingClientRect());
          results.push({ label: `${scale * 100}% ${sample.label}: ${sample.text.slice(0, 60)}`,
            retained: node.textContent === sample.text,
            singleLine: lines.size === 1 && Math.abs(box.height - parseFloat(style.lineHeight)) < 1
              && node.scrollHeight <= node.clientHeight + 1,
            overflowClipped: style.overflowX === "hidden" && style.textOverflow === "ellipsis",
            fitsPage: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
            ordered: rows.every((row, index) => index === 0 || rows[index - 1].bottom <= row.top),
            dockStable: ["x", "y", "width", "height"].every(key => Math.abs(currentDock[key as keyof DOMRect] as number - originalDock[key]) < 1),
            complete: scale !== 1 || !sample.complete || node.scrollWidth <= node.clientWidth,
            truncated: !sample.truncated || node.scrollWidth > node.clientWidth });
        }
      }
      return results;
    });
    for (const { label, ...checks } of samples) {
      expect(checks, label).toEqual({ retained: true, singleLine: true, overflowClipped: true,
        fitsPage: true, ordered: true, dockStable: true, complete: true, truncated: true });
    }
  });

  test(`底部操作区与台词内部滚动 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: "示例短台词。", displays: 14 });
    const bottomTop = await assertLayout(page);
    const scroll = page.locator(".dialogue-scroll");
    expect(await scroll.evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
    await page.locator("#dialogue-text").evaluate((e, text) => { e.textContent = text; }, longLine + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(30));
    await expect.poll(() => scroll.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await scroll.evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(viewport.height <= 760 ? 136 : 160);
    if (viewport.width > 320) expect(await scroll.evaluate((e) => e.clientHeight)).toBe(160);
    expect(await assertLayout(page)).toBe(bottomTop);
    await page.locator(".character-portrait").focus();
    await page.keyboard.press("Enter");
    expect(await assertLayout(page)).toBe(bottomTop);
    await scroll.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    expect(await scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    const box = (await scroll.boundingBox())!;
    expect(await scroll.evaluate((e) => {
      const box = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(box.left + 2, box.top + box.height / 2));
    })).toBe(true);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await scroll.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(0);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`table-long-${viewport.width}.png`) });
  });

  test(`打字跟随、暂停、恢复与重绘 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: longLine, reducedMotion: false });
    const scroll = page.locator(".dialogue-scroll");
    const text = page.locator("#dialogue-text");
    await page.clock.runFor(4800);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    expect(await scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(4);
    await scroll.evaluate((e) => { e.scrollTop = 20; e.dispatchEvent(new Event("scroll")); });
    const lengthBefore = await text.evaluate((e) => e.textContent!.length);
    await page.clock.runFor(480);
    expect(await text.evaluate((e) => e.textContent!.length)).toBeGreaterThan(lengthBefore);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    await page.locator(".draw-skill-button").click();
    await expect(page.locator(".skill-draw-modal")).toBeVisible();
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    expect(await text.evaluate((e) => e.textContent!.length)).toBeLessThan(longLine.length);
    await page.locator(".skill-draw-card").first().click();
    await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    await scroll.evaluate((e) => { e.scrollTop = e.scrollHeight - e.clientHeight - 3; e.dispatchEvent(new Event("scroll")); });
    await page.clock.runFor(960);
    expect(await scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    expect(await text.evaluate((e) => e.textContent!.length)).toBeLessThan(10);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
    await assertLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`table-typing-${viewport.width}.png`) });
  });
}

for (const phase of ["turns", "round-reveal", "roulette-trigger", "roulette-result", "round-end"]) {
  test(`窄屏回合按钮与技能建议 ${phase}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mountTable(page, { text: longLine, phase, displays: phase === "roulette-result" ? 0 : 3 });
    await assertLayout(page);
    await expect(page.locator(".skill-advice")).toHaveCount(0);
    await expect(page.locator(".action-dock button").first()).toBeVisible();
    await expect(page.locator("#dialogue-text")).toHaveText(longLine);
    if (phase === "roulette-result") {
      const addedLines = await page.locator(".dialogue-scroll").evaluate((e) => (e.clientHeight - 96) / parseFloat(getComputedStyle(e).lineHeight));
      expect(addedLines).toBeGreaterThanOrEqual(1.9);
      expect(addedLines).toBeLessThanOrEqual(2.1);
    }
    if (phase === "turns") {
      const scroll = page.locator(".dialogue-scroll");
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
      // A completed, motion-free line must retain the opening on a redraw too.
      await page.locator(".draw-skill-button").click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
      await page.locator(".skill-draw-card").first().click();
      await scroll.evaluate((e) => { e.scrollTop = 20; e.dispatchEvent(new Event("scroll")); });
      await page.locator(".draw-skill-button").click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
      await page.locator(".skill-draw-card").first().click();
      expect(await scroll.evaluate((e) => e.scrollTop)).toBe(20);
    }
    await page.screenshot({ path: testInfo.outputPath(`table-phase-${phase}.png`) });
  });
}


test("调试面板保持可访问且不挤占牌桌", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mountTable(page, { text: "示例台词。", debug: true });
  expect(await page.locator(".action-dock").evaluate((e) => e.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await page.locator("[data-copy-debug]").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-copy-debug]")).toBeVisible();
  await expect(page.locator(".dev-hud")).toContainText("开发者面板");
});


async function opaquePoint(page: Page, overlapDashboard = false) {
  return page.locator(".character-portrait").evaluate(async (img: HTMLImageElement, overlap) => {
    const { visibleCharacterImagePoint } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
    const box = img.getBoundingClientRect();
    const dashboard = document.querySelector(".table-dashboard")!.getBoundingClientRect();
    for (let y = Math.max(0, box.top); y < Math.min(innerHeight, box.bottom); y += 4) for (let x = Math.max(0, box.left); x < Math.min(innerWidth, box.right); x += 4) {
      if (!visibleCharacterImagePoint(img, x, y)) continue;
      if (overlap ? x > dashboard.left && x < dashboard.right && y > dashboard.top && y < dashboard.bottom : document.elementFromPoint(x, y) === img) return { x, y };
    }
    throw Error("Missing opaque character point");
  }, overlapDashboard);
}

for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }]) {
  test(`立绘稳定、点击换层、对白隐藏至更新 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountTable(page, { text: "示例短对白。", displays: 1, rankBoard: true });
    const portrait = page.locator(".character-portrait"), stage = page.locator(".table-stage"), bubble = page.locator(".dialogue");
    await expect.poll(() => portrait.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const art = () => portrait.evaluate((img: HTMLImageElement) => {
      const box = img.getBoundingClientRect(), scale = Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
      return { x: box.x, y: box.y, width: img.naturalWidth * scale, height: img.naturalHeight * scale };
    });
    const original = await art();
    expect(original.width).toBeGreaterThanOrEqual(224);
    expect(original.height).toBeGreaterThanOrEqual(149);
    await expect(page.locator(".rank-record-cell")).toHaveCount(13);
    await expect(page.locator("[data-display-toggle]")).toHaveCount(0);
    await expect(stage).toHaveAttribute("data-foreground", "information");
    await page.mouse.click(...Object.values(await opaquePoint(page)) as [number, number]);
    await expect(stage).toHaveAttribute("data-foreground", "character");
    expect(await art()).toEqual(original);
    if (viewport.width === 320) {
      const overlap = await opaquePoint(page, true);
      expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.classList.contains("character-portrait"), overlap)).toBe(true);
      // This visible label lies under transparent image padding: use a real pointer
      // so the image handler must forward it to the information layer.
      const label = (await page.locator(".gun-name").first().boundingBox())!;
      await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
      await expect(stage).toHaveAttribute("data-foreground", "information");
      expect(await page.evaluate(p => document.querySelector(".table-dashboard")!.contains(document.elementFromPoint(p.x, p.y)), overlap)).toBe(true);
    }
    await portrait.focus(); await page.keyboard.press("Enter");
    if (viewport.width === 320) expect((await bubble.boundingBox())!.width).toBeGreaterThanOrEqual(134);
    await bubble.click({ position: { x: 12, y: 12 } });
    await expect(bubble).toBeHidden();
    await expect(page.getByRole("button", { name: "隐藏当前对白，下一次对白更新时显示" })).toHaveCount(0);
    expect(await art()).toEqual(original);
    // A skill drawer/modal redraw must retain the dismissal and selected layer.
    await page.locator(".draw-skill-button").click();
    await page.locator(".skill-draw-card").first().click();
    await expect(bubble).toBeHidden();
    await expect(stage).toHaveAttribute("data-foreground", "character");
    await portrait.focus(); await page.keyboard.press("Enter");
    await expect(bubble).toBeHidden(); // No tap provider: raising the character alone is not a new line.
    await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
    await expect(bubble).toBeVisible(); // A real dialogue event can choose the same text with a new key.
    expect(await art()).toEqual(original);
    await page.screenshot({ path: testInfo.outputPath(`stable-layers-${viewport.width}.png`) });
    // Long text scrolls without being interpreted as a dismissing tap.
    await mountTable(page, { text: longLine, displays: 1, rankBoard: true });
    await portrait.focus(); await page.keyboard.press("Enter");
    const scroll = page.locator(".dialogue-scroll");
    const scrollBox = (await scroll.boundingBox())!;
    await page.mouse.move(scrollBox.x + 10, scrollBox.y + 20); await page.mouse.down();
    await page.mouse.move(scrollBox.x + 10, scrollBox.y + 45, { steps: 5 }); await page.mouse.up();
    await expect(bubble).toBeVisible();
    await scroll.focus(); await page.keyboard.press("End");
    await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    expect(await art()).toEqual(original);
    await scroll.press("Enter"); await expect(bubble).toBeHidden();
    await mountTable(page, { text: "示例短对白。", displays: 14, rankBoard: true });
    await expect(bubble).toBeVisible();
    expect(await art()).toEqual(original); // Status count does not affect portrait geometry.
  });
}
