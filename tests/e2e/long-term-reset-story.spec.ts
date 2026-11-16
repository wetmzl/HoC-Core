import { skipStory } from "./story-platform-fixture";
import { expect, test, type Page } from "@playwright/test";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

const openingId = "hoc-core/official-story#opening";
const story = (page: Page) => page.locator("[data-story-player]");

async function snapshot(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot();
  });
}

async function deleteLongTerm(page: Page): Promise<void> {
  await page.locator(".lobby-settings-button").click();
  await page.locator("[data-reset]").click();
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await expect(page.locator('[data-game-dialog-choice="confirm"]')).toHaveCount(0);
  await expect.poll(async () => {
    const current = await snapshot(page);
    return { completed: current.story?.completed ?? [], once: current.story?.once ?? [], records: current.notebook?.characters ?? [] };
  }).toEqual({ completed: [], once: [], records: [] });
}

test.beforeEach(async ({ page }) => {

  for (const selector of ["[data-acknowledge-third-party-content]", "[data-acknowledge-adult-content]", "[data-tutorial-skip]"]) {
    await page.addLocatorHandler(page.locator(selector).first(), async button => { await button.click(); }, { noWaitAfter: true });
  }
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave("2026-11-14T00:00:00.000Z");
    save.profile.displayName = "清档回归";
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    // A pre-existing personal record proves reset clears its independent sidecar too.
    const notebook = { format: "hoc-notebook-save", schemaVersion: 1,
      characters: [{ characterId: "llama", endings: ["playerDefeat"] }] };
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    await repository.projectSnapshot((current: any) => ({ ...current, longTerm: save, runtime: null, story: null, notebook }), { notebookReplacement: true });
  });
});

for (const reload of [false, true]) {
  test(`deleting long-term progress restarts the opening ${reload ? "after refresh" : "without refresh"}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.locator("[data-start-game]").click();
    await page.locator("[data-enter-duel]").click();
    await expect(story(page)).toBeVisible();
    const oldRequest = (await snapshot(page)).story.active.request.id;
    await skipStory(page);
    await expect(story(page)).toHaveCount(0);
    await expect.poll(async () => (await snapshot(page)).story?.completed.find((entry: any) => entry.sceneId === openingId)?.status).toBe("skipped");
    await page.locator("[data-lobby-home]").click();
    await deleteLongTerm(page);

    if (reload) {
      await page.reload();
      await expect(page.locator("[data-start-game]")).toBeEnabled();
      await page.locator("[data-start-game]").click();
    }
    await page.locator("[data-open-notebook]").click();
    await page.locator('[data-notebook-section="stories"]').click();
    await expect(page.locator("[data-notebook-play]")).toHaveCount(0);
    await expect(page.getByText("还没有剧情记录", { exact: true })).toBeVisible();
    await page.locator("[data-notebook-back]").click();
    await page.locator('[data-notebook-section="records"]').click();
    await expect(page.locator("[data-notebook-character]")).toHaveCount(0);
    await page.locator("[data-notebook-back]").click();
    await page.locator("[data-notebook-back]").click();
    await page.locator("[data-enter-duel]").click();
    await expect(story(page)).toBeVisible();
    const restarted = (await snapshot(page)).story;
    expect(restarted.active.request.sceneId).toBe(openingId);
    expect(restarted.active.request.id).not.toBe(oldRequest);
    expect(restarted.completed).toEqual([]);
    await expect(page.locator(".table-bottom")).toHaveCount(0);
    await skipStory(page);
    await expect(story(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator("[data-start-game]")).toBeEnabled();
    const persisted = (await snapshot(page)).story;
    expect(persisted.completed.filter((entry: any) => entry.sceneId === openingId)).toHaveLength(1);
  });
}

test("clearing progress preserves a disabled story package; enabling it restores the new opening", async ({ page }) => {
  test.setTimeout(120_000);
  await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  await expect(story(page)).toBeVisible();
  await skipStory(page);
  await expect(story(page)).toHaveCount(0);
  await page.locator("[data-lobby-home]").click();
  await page.locator("[data-exit-launcher]").click();
  await page.locator("[data-open-packages]").click();
  const card = page.locator('.package-card[data-package-id="hoc-core/official-story"]');
  await card.locator('[data-package-action="disable"]').click();
  await respondToOfficialPlaylistCopy(page, "confirm");
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click();
  await deleteLongTerm(page);
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator(".lobby-character-shell")).toBeVisible();
  await expect(story(page)).toHaveCount(0);
  expect((await snapshot(page)).story?.completed ?? []).toEqual([]);
  await page.locator("[data-lobby-home]").click();
  await page.locator("[data-exit-launcher]").click();
  await page.locator("[data-open-packages]").click();
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await card.locator('[data-package-action="enable"]').click();
  await expect(card).toHaveAttribute("data-package-state", "enabled");
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  await expect(story(page)).toBeVisible();
  expect((await snapshot(page)).story.active.request.sceneId).toBe(openingId);
});
