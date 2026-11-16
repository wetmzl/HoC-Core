import { expect, test, type Page } from "@playwright/test";
import { tapStory } from "./story-platform-fixture";

const player = (page: Page) => page.locator("[data-story-player]");
const exit = (page: Page) => player(page).locator('[aria-label="退出剧情确认"]');
type Pulse = { pattern: number[]; at: number };
async function pulses(page: Page): Promise<Pulse[]> {
  return page.evaluate(() => (window as any).__storyHapticCalls.filter((call: Pulse) => call.pattern.some(duration => duration > 0)));
}
async function clearPulses(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__storyHapticCalls = []; });
}
async function seed(page: Page, reducedMotion = false): Promise<void> {
  await page.evaluate(async reducedMotion => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = reducedMotion;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  }, reducedMotion);
}
async function nativeBack(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/platform/back-navigation.ts")).requestBack("native");
  });
}
async function leaveStory(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await exit(page).getByRole("button", { name: "退出剧情", exact: true }).click();
  await expect(player(page)).toHaveCount(0);
  if (await page.locator("[data-lobby-home]").isVisible()) await page.locator("[data-lobby-home]").click();
}
async function openReplay(page: Page): Promise<void> {
  await page.locator("[data-open-notebook]").click();
  await page.locator('[data-notebook-section="stories"]').click();
  await page.locator('[data-notebook-play="hoc-core/official-story#opening"]').click();
  await expect(player(page)).toBeVisible();
}
async function fullText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const snapshot = await (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot();
    return snapshot.story.active.run.waiting.node.segments.map((segment: any) => segment.text ?? "").join("");
  });
}

test.beforeEach(async ({ page }) => {

  await page.addInitScript(() => {
    (window as any).__storyHapticCalls = [];
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number | number[]) => {
      (window as any).__storyHapticCalls.push({ pattern: Array.isArray(pattern) ? pattern : [pattern], at: performance.now() });
      return true;
    } });
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  await page.addLocatorHandler(page.locator("[data-acknowledge-third-party-content]"), async button => { await button.click(); });
  await page.addLocatorHandler(page.locator("[data-acknowledge-adult-content]"), async button => { await button.click(); });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  await seed(page);
  await page.locator("[data-start-game]").click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
});

test("office backdrop is portrait and both native Back and browser Back require a reversible story exit confirmation", async ({ page }, info) => {
  await page.locator("[data-enter-duel]").click();
  await expect(player(page)).toBeVisible();
  const backdrop = player(page).locator(".story-stage-background");
  const office = await backdrop.evaluate(async node => {
    const source = getComputedStyle(node).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (!source) throw new Error("missing office background");
    const image = new Image(); image.src = source; await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, source };
  });
  expect(office.height).toBeGreaterThan(office.width);
  expect(office.source).not.toContain("gambling-table-menu");
  await nativeBack(page);
  await expect(exit(page)).toBeVisible();
  await expect(player(page).locator(".story-player-layout")).toHaveJSProperty("inert", true);
  await page.screenshot({ path: info.outputPath("story-back-confirmation.png"), animations: "disabled" });
  await nativeBack(page);
  await expect(exit(page)).toBeHidden();
  await expect(player(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(exit(page)).toBeVisible();
  await exit(page).getByRole("button", { name: "继续播放", exact: true }).click();
  await expect(exit(page)).toBeHidden();
  await expect(player(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exit(page)).toBeVisible();
  await exit(page).getByRole("button", { name: "退出剧情", exact: true }).click();
  await expect(player(page)).toHaveCount(0);
  await expect(page.locator(".table-shell")).toHaveCount(0);
  await expect(page.locator(".lobby-shell")).toBeVisible();
});

test("streaming haptics are paced, completion fires once and the two device switches independently control feedback", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await clearPulses(page);
  await page.locator("[data-enter-duel]").click();
  await expect(player(page)).toBeVisible();
  // The modal opens during the preceding stage checkpoint; wait for the actual line.
  await expect(player(page)).toHaveAttribute("data-story-typing", "true");
  const text = await fullText(page);
  await page.clock.runFor(650);
  const partial = await player(page).locator(".story-text").textContent();
  expect(partial!.length).toBeGreaterThan(0);
  expect(partial!.length).toBeLessThan(text.length);
  const stream = (await pulses(page)).filter(call => call.pattern.length === 1 && call.pattern[0] === 4);
  expect(stream.length).toBeGreaterThan(1);
  for (let index = 1; index < stream.length; index++) expect(stream[index].at - stream[index - 1].at).toBeGreaterThanOrEqual(89);
  expect((await pulses(page)).some(call => call.pattern[0] === 8)).toBe(true);
  await page.clock.runFor(10_000);
  await expect(player(page).locator(".story-text")).toHaveText(text);
  expect((await pulses(page)).filter(call => call.pattern[0] === 14)).toHaveLength(1);
  await page.clock.runFor(10_000);
  expect((await pulses(page)).filter(call => call.pattern[0] === 14)).toHaveLength(1);
  await leaveStory(page);
  await page.locator('[data-open="settings"]').click();
  await expect(page.locator('[data-setting="hapticsEnabled"]')).toBeChecked();
  await expect(page.locator('[data-setting="outputHapticsEnabled"]')).toBeChecked();
  await page.locator('[data-setting="outputHapticsEnabled"]').uncheck();
  await page.locator('#settings [data-close]').click();
  await page.clock.runFor(250);
  await clearPulses(page);
  await openReplay(page);
  await page.clock.runFor(10_000);
  expect((await pulses(page)).some(call => call.pattern[0] === 4)).toBe(false);
  expect((await pulses(page)).filter(call => call.pattern[0] === 14)).toHaveLength(1);
  await leaveStory(page);
  // Replays return to the archive, whose Back controls lead back to the lobby.
  await page.locator("[data-notebook-back]").click();
  await page.locator("[data-notebook-back]").click();
  await page.locator('[data-open="settings"]').click();
  await page.locator('[data-setting="hapticsEnabled"]').uncheck();
  await expect(page.locator('[data-setting="outputHapticsEnabled"]')).not.toBeChecked();
  await page.locator('#settings [data-close]').click();
  await page.clock.runFor(250);
  await clearPulses(page);
  await openReplay(page);
  await page.clock.runFor(10_000);
  await tapStory(page);
  await page.clock.runFor(10_000);
  expect(await pulses(page)).toEqual([]);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-start-game]").click();
  await page.locator('[data-open="settings"]').click();
  await expect(page.locator('[data-setting="hapticsEnabled"]')).not.toBeChecked();
  await expect(page.locator('[data-setting="outputHapticsEnabled"]')).not.toBeChecked();
});
