import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
  for (const displayCount of [1, 2, 3, 4, 14]) test(`中性声明式展示：双方、多项、弹窗及布局 ${viewport.width} / ${displayCount}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    // Install neutral declarations into the already loaded catalog, then mount
    // the actual runtime with a validated save. No community content is used.
    await page.evaluate(async (displayCount) => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      await load("/src/table-screen-module.ts");
      const { bootstrapContent } = await load("/src/content/packages/content-loader.ts");
      await bootstrapContent({ fetch: window.fetch.bind(window) });
      const registry = await load("/src/core/abilities/registry.ts");
      const { createMatch } = await load("/src/core/match/reducer.ts");
      const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
      const { createPersistenceService } = await load("/src/persistence/factory.ts");
      const { mountGameRuntime } = await load("/src/match-screen.ts");
      const memory = { id: "example-memory", defaultDuration: "match", rules: [] };
      const query = (key: string) => ({ type: "status-parameter", target: "owner", statusDefinitionId: memory.id, key });
      const talent = {
        id: "example-display-talent", name: "记忆展示", description: "中性展示夹具", sourceKind: "talent", primaryDomain: "gambler", tags: ["display"], activation: { type: "automatic" }, unlock: { type: "defeat-count", count: 1, label: "示例" },
        rules: [{ id: "remember", trigger: "on-match-created", effects: [{ type: "add-status", target: "owner", statusDefinitionId: memory.id, parameters: { rank: "Q", suit: "spades" } }] }],
        displays: [{ id: "memory", target: "owner", description: "当前记住的牌。", content: [{ type: "text", text: "记忆：" }, { type: "card", rank: query("rank"), suit: query("suit") }] }, { id: "zero", target: "owner", description: "零值仍显示。", content: [{ type: "text", text: "数值：" }, { type: "number", value: 0 }] }]
      };
      const ai = { id: "example-display-ai", name: "对手展示", description: "中性展示夹具", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["display"], activation: { type: "automatic" }, rules: [], displays: [
        { id: "probability", target: "owner", description: "百分比展示。", content: [{ type: "text", text: "概率：" }, { type: "number", value: 0.5, format: "percent" }] },
        { id: "missing", target: "owner", description: "数据缺失。", content: [{ type: "text", text: "待记忆：" }, { type: "card", rank: query("rank"), suit: query("suit") }] }
      ] };
      if (displayCount === 1) {
        talent.displays = [];
        ai.displays = ai.displays.slice(0, 1);
      } else if (displayCount === 3) {
        ai.displays = ai.displays.slice(0, 1);
      } else if (displayCount === 2) {
        talent.displays = talent.displays.slice(0, 1);
        ai.displays = ai.displays.slice(0, 1);
      } else if (displayCount > 4) {
        ai.displays.push(...Array.from({ length: displayCount - 4 }, (_, index) => ({ id: `extra-${index}`, target: "owner", description: "滚动展示。", content: [{ type: "text", text: `额外状态 ${index + 1}：` }, { type: "number", value: index }] })) as any);
      }
      registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, talent, ai], [...registry.STATUS_DEFINITIONS, memory], registry.ABILITY_CATALOG_VERSION);
      const match = createMatch("neutral-display-layout", { opponentId: "chatgpt", talentIds: [talent.id], opponentAiSkills: [{ definitionId: ai.id, enabled: true, parameters: {} }] });
      const repo = createPersistenceService();
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false;
      await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
      const root = document.querySelector<HTMLElement>("#app")!;
      void mountGameRuntime({ root, onExitRequest: async () => {} });
    }, displayCount);
    const warning = page.locator("#adult-content-warning");
    if (await warning.isVisible()) await warning.getByRole("button", { name: "我已成年并继续" }).click();
    const panel = page.locator(".display-panel");
    const layout = () => page.evaluate(() => ({
      pageFits: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
      buttonsVisible: document.querySelector(".action-dock")!.getBoundingClientRect().bottom <= innerHeight,
      dockTop: document.querySelector(".action-dock")!.getBoundingClientRect().top
    }));
    await expect(panel).toBeVisible();
    expect((await layout()).pageFits).toBe(true);
    expect((await layout()).buttonsVisible).toBe(true);
    const dockTop = (await layout()).dockTop;
    const toggle = panel.locator("[data-display-toggle]");
    if (displayCount > 3) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".status-chip:visible")).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath(`displays-collapsed-${viewport.width}.png`) });
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect((await layout()).dockTop).toBe(dockTop);
    } else {
      await expect(toggle).toHaveCount(0);
      await expect(page.locator(".status-chip:visible")).toHaveCount(displayCount);
      expect(await panel.locator(".display-scroll").evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    }
    await expect(page.locator("[data-display-actor=player] .status-chip")).toHaveCount(displayCount === 1 ? 0 : displayCount === 2 ? 1 : 2);
    await expect(page.locator("[data-display-actor=opponent] .status-chip")).toHaveCount(displayCount <= 3 ? 1 : displayCount - 2);
    await expect(page.locator("[data-display-actor=opponent] .status-chip").first()).toContainText("概率：50%");
    if (displayCount > 1) await expect(page.locator("[data-display-actor=player] .status-chip").first()).toContainText("记忆：Q♠");
    if (displayCount >= 3) await expect(page.locator("[data-display-actor=player] .status-chip").last()).toContainText("数值：0");
    if (displayCount > 3) await expect(page.locator("[data-display-actor=opponent] .status-chip").nth(1)).toContainText("待记忆：—");
    if (displayCount === 14) {
      expect(await panel.locator(".display-scroll").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await panel.locator(".display-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await panel.locator(".display-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    }
    const info = page.locator(`[data-display-actor=${displayCount === 1 ? "opponent" : "player"}] .display-info-button`).first();
    await info.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#display-info-dialog")).toBeVisible();
    await expect(page.locator("#display-info-description")).toHaveText(displayCount === 1 ? "百分比展示。" : "当前记住的牌。");
    await page.keyboard.press("Escape");
    await expect(page.locator("#display-info-dialog")).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (displayCount === 14) {
      const scrollBefore = await panel.locator(".display-scroll").evaluate((element) => element.scrollTop);
      await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => panel.locator(".display-scroll").evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    }
    expect((await layout()).pageFits).toBe(true);
    const overlap = await page.evaluate(() => [...document.querySelectorAll(".status-chip")].some((chip) => {
      const a = chip.getBoundingClientRect();
      const scroller = document.querySelector(".display-scroll")!.getBoundingClientRect();
      if (a.bottom <= scroller.top || a.top >= scroller.bottom) return false;
      return [...document.querySelectorAll(".cards, .action-dock")].some((other) => { const b = other.getBoundingClientRect(); return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; });
    }));
    expect(overlap).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`displays-${viewport.width}.png`) });
    if (displayCount > 3) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".status-chip:visible")).toHaveCount(3);
      expect((await layout()).dockTop).toBe(dockTop);
    }
  });
}

test("状态栏花色使用固定图形并保留可读牌面", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    const { displayContentMarkup } = await load("/src/presentation/displays.ts");
    const container = document.createElement("div");
    container.id = "suit-fixture";
    container.innerHTML = displayContentMarkup({ content: [
      ...["spades", "hearts", "diamonds", "clubs"].flatMap((suit) => [
        { type: "card", rank: "Q", suit, format: "inline" },
        { type: "card", rank: "Q", suit, format: "compact" },
        { type: "suit", value: suit }
      ]),
      { type: "card", rank: "Q", suit: null, format: "inline" },
      { type: "card", rank: null, suit: "hearts", format: "compact" },
      { type: "suit", value: null }
    ] });
    document.querySelector("#app")!.replaceChildren(container);
  });
  const cards = page.locator("#suit-fixture .display-card");
  for (const [index, symbol] of ["♠", "♥", "♦", "♣"].entries()) {
    for (const variant of [0, 1]) {
      const card = cards.nth(index * 2 + variant);
      await expect(card).toHaveText(`Q${symbol}`);
      await expect(card.locator(".display-card-rank")).toHaveText("Q");
      const icon = card.locator("svg");
      await expect(icon).toBeVisible();
      const box = await icon.boundingBox();
      expect(box!.width).toBeGreaterThan(8);
      expect(box!.height).toBeGreaterThan(8);
      expect(await icon.evaluate((element) => getComputedStyle(element).fill)).toBe(
        variant === 1 ? (index === 1 || index === 2 ? "rgb(201, 47, 78)" : "rgb(21, 26, 30)")
          : index === 1 || index === 2 ? "rgb(255, 102, 133)" : "rgb(241, 241, 234)"
      );
    }
  }
  await expect(page.locator("#suit-fixture > .display-suit").nth(0)).toHaveText("♠");
  await expect(cards.nth(8)).toHaveText("—");
  await expect(cards.nth(9)).toHaveText("—");
  await expect(cards.nth(8).locator("svg")).toHaveCount(0);
  await expect(cards.nth(9).locator("svg")).toHaveCount(0);
  await expect(page.locator("#suit-fixture > .display-suit").last()).toHaveText("—");
});
