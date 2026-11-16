import { expect, test } from "@playwright/test";

test("restored story art retries without losing the line, duplicating history or advancing progress", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createStoryPresenter } = await load("/src/presentation/story-presenter.ts");
    const { createStoryRun, advanceStory } = await load("/src/core/story/engine.ts");
    const scene = { entry: "stage", actors: { guide: { name: "引导员", image: "guide.svg" } }, nodes: [
      { id: "stage", type: "present", action: { type: "stage", actors: [{ id: "guide" }] }, next: "line" },
      { id: "line", type: "say", segments: [{ text: "恢复到本句。" }], next: "end" },
      { id: "end", type: "end" }
    ] };
    const context = { resolveScene: () => scene };
    const run = advanceStory(createStoryRun("recovery", context), context);
    const probe = (window as any).__storyRecovery = { failing: true, attempts: 0, retries: 0, advances: 0, run };
    const presenter = createStoryPresenter({
      resolveAsset: () => { probe.attempts++; if (probe.failing) throw Error("临时断网"); return "/favicon.svg"; },
      resolveScene: () => scene, reducedMotion: () => true,
      onAdvance: () => { probe.advances++; }, onChoice: () => {}, onSkip: () => {}, onCancel: () => {},
      onRetry: () => { probe.retries++; presenter.update(run); }
    });
    presenter.update(run, { restored: true });
  });
  const player = page.locator("[data-story-player]"), error = player.locator(".story-error");
  await expect(error).toContainText("临时断网");
  await error.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__storyRecovery.attempts)).toBe(2);
  await expect(error).toBeVisible();
  await page.evaluate(() => { (window as any).__storyRecovery.failing = false; });
  const before = await page.evaluate(() => JSON.stringify((window as any).__storyRecovery.run));
  await error.getByRole("button", { name: "重试", exact: true }).click();
  await expect(error).toBeHidden();
  await expect(player.locator(".story-actor")).toBeVisible();
  await expect.poll(() => player.locator(".story-actor").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(player.locator(".story-text")).toHaveText("恢复到本句。");
  const after = await page.evaluate(() => {
    const probe = (window as any).__storyRecovery;
    return { attempts: probe.attempts, retries: probe.retries, advances: probe.advances, run: JSON.stringify(probe.run) };
  });
  expect(after).toEqual({ attempts: 3, retries: 1, advances: 0, run: before });
  await player.getByRole("button", { name: "回看", exact: true }).click();
  await expect(player.locator(".story-log li")).toHaveCount(1);
});
