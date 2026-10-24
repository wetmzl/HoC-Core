import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshots = resolve("output/opening-refresh-review");
async function capture(page: Page, name: string) {
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, `${name}.png`), fullPage: true });
}
async function storedMatch(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    return (await createPersistenceService().loadRuntime())?.activeMatch;
  });
}
async function mount(page: Page, restore = false, talents = true, audioProbe = false) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async ({ restore, talents, audioProbe }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    if (!restore) {
      const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
      const { createMatch } = await load("/src/core/match/reducer.ts");
      const { PLAYER_SKILL_DEFINITIONS } = await load("/src/core/skills/definitions.ts");
      const activeIds = PLAYER_SKILL_DEFINITIONS.filter((s: any) => s.category === "active" && s.drop.enabled).map((s: any) => s.id);
      const base = createMatch("opening-refresh-ui", { opponentId: "chatgpt", unlockedPlayerSkillIds: activeIds, skillDeckIds: activeIds,
        talentIds: talents ? ["early-preparation", "resilient-spirit", "second-chance", "well-prepared"] : [] });
      const match = { ...base, playerSkills: { ...base.playerSkills, drawCount: 2 }, round: { ...base.round, phase: "turns", currentActor: "player" } };
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = audioProbe; save.settings.reducedMotion = true;
      save.tutorialProgress.completedIds.push("adult-content-warning");
      await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    }
    if (audioProbe) {
      const { gameAudio } = await load("/src/audio/game-audio.ts");
      const cues: [string, number][] = (window as any).__openingAudio = [];
      const playback: number[] = (window as any).__openingPlayback = [];
      const originalPlay = gameAudio.play.bind(gameAudio);
      gameAudio.play = (cue: string, delayMs = 0) => { cues.push([cue, delayMs]); originalPlay(cue, delayMs); };
      const originalStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (this.buffer) playback.push(this.buffer.duration);
        return originalStart.apply(this, args);
      };
    }
    const { mountGameRuntime } = await load("/src/match-screen.ts");
    (window as any).__openingRuntime = await mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  }, { restore, talents, audioProbe });
  await expect(page.locator(".table-bottom")).toBeVisible();
}

test("技能抽取播放三连滑牌、选中收牌，恢复候选不重播", async ({ page }) => {
  await mount(page, false, true, true);
  const cues = () => page.evaluate(() => (window as any).__openingAudio);
  const playback = () => page.evaluate(() => (window as any).__openingPlayback);
  expect(await cues()).toEqual([]);
  await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
  await expect(page.locator(".skill-draw-card")).toHaveCount(3);
  expect(await cues()).toEqual([["skillDraw", 0]]);
  await expect.poll(playback).toHaveLength(1);
  expect((await playback())[0]).toBeCloseTo(0.44, 3);

  await page.getByRole("button", { name: "刷新（剩余 1 次）", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新（剩余 0 次）", exact: true })).toBeDisabled();
  expect(await cues()).toEqual([["skillDraw", 0], ["skillDraw", 0]]);
  await expect.poll(playback).toHaveLength(2);
  await expect.poll(async () => (await storedMatch(page))?.playerSkills.drawOffer?.refreshesRemaining).toBe(0);

  await mount(page, true, true, true);
  await expect(page.locator(".skill-draw-card")).toHaveCount(3);
  expect(await cues()).toEqual([]);
  expect(await playback()).toEqual([]);
  await page.locator(".skill-draw-card").first().click();
  await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
  expect(await cues()).toEqual([["skillAcquire", 0]]);
  await expect.poll(playback).toHaveLength(1);
  expect((await playback())[0]).toBeCloseTo(0.430417, 3);
});

for (const width of [1280, 390, 320]) {
  test(`开局手牌、刷新额度与读档 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 720 : width === 390 ? 844 : 900 });
    await mount(page);
    expect((await storedMatch(page))?.playerSkills.cards).toHaveLength(4);
    await capture(page, `opening-${width}`);
    await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
    const button = page.getByRole("button", { name: "刷新（剩余 1 次）", exact: true });
    await expect(button).toBeEnabled();
    await expect(page.locator(".skill-draw-card")).toHaveCount(3);
    const before = await storedMatch(page);
    await capture(page, `refresh-ready-${width}`);
    await button.click();
    await expect(page.getByRole("button", { name: "刷新（剩余 0 次）", exact: true })).toBeDisabled();
    const after = await storedMatch(page);
    expect(after?.playerSkills.drawCount).toBe(before?.playerSkills.drawCount);
    expect(after?.playerSkills.drawOffer?.refreshesRemaining).toBe(0);
    expect(after?.rng.loot).not.toEqual(before?.rng.loot);
    await capture(page, `refresh-spent-${width}`);
    await mount(page, true);
    await expect(page.getByRole("button", { name: "刷新（剩余 0 次）", exact: true })).toBeDisabled();
    expect((await storedMatch(page))?.playerSkills.drawOffer).toEqual(after?.playerSkills.drawOffer);
    await page.locator(".skill-draw-card").first().click();
    await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
    expect((await storedMatch(page))?.playerSkills.drawCount).toBe(1);
    expect((await storedMatch(page))?.playerSkills.cards).toHaveLength(5);
    await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
    await expect(page.getByRole("button", { name: "刷新（剩余 1 次）", exact: true })).toBeEnabled();
    const fits = await page.locator(".skill-draw-modal").evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    expect(fits).toBe(true);
  });
}
test("未解锁时开局三张且刷新禁用", async ({ page }) => {
  await mount(page, false, false);
  expect((await storedMatch(page))?.playerSkills.cards).toHaveLength(3);
  await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
  await expect(page.getByRole("button", { name: "刷新（剩余 0 次）", exact: true })).toBeDisabled();
});
test("官方天赋路线显示四项能力与十人预告", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const { createDefaultSave } = await import(/* @vite-ignore */ "/src/persistence/boot.ts");
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await createPersistenceService().saveLongTerm(save);
  });
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.getByRole("button", { name: "技能与天赋", exact: true }).click();
  await page.getByRole("tab", { name: "天赋", exact: true }).click();
  for (const name of ["早有准备", "越挫越勇", "再给一次机会", "有备而来", "敬请期待"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(await page.locator(".talent-checkpoint").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-threshold")))).toEqual(["1", "3", "5", "7", "10"]);
  await capture(page, "talent-road-390");
  await page.locator('.talent-checkpoint[data-threshold="10"]').scrollIntoViewIfNeeded();
  await capture(page, "talent-road-bottom-390");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator("#skills").evaluate(el => { el.scrollTop = 0; el.querySelectorAll("*").forEach(child => { child.scrollTop = 0; }); });
  await capture(page, "talent-road-1280");
});


test("三张候选按音效起音点依次出现，隐藏期间不可聚焦", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => document.body.classList.remove("reduced-motion"));
  await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
  const visibilityAt = (time: number) => page.locator(".skill-draw-tile").evaluateAll((tiles, time) => tiles.map(tile => {
    const animation = tile.getAnimations()[0];
    if (!animation) throw new Error("Missing reveal animation");
    animation.pause(); animation.currentTime = time;
    return getComputedStyle(tile).visibility;
  }), time);
  expect(await visibilityAt(40)).toEqual(["hidden", "hidden", "hidden"]);
  expect(await page.locator(".skill-draw-card").first().evaluate((button: HTMLButtonElement) => {
    button.focus(); return document.activeElement === button;
  })).toBe(false);
  expect(await visibilityAt(42)).toEqual(["visible", "hidden", "hidden"]);
  expect(await visibilityAt(154)).toEqual(["visible", "visible", "hidden"]);
  expect(await visibilityAt(298)).toEqual(["visible", "visible", "visible"]);
  await page.evaluate(() => document.body.classList.add("reduced-motion"));
  await expect(page.locator(".skill-draw-card").last()).toBeVisible();
});
