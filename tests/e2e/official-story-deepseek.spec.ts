import { skipStory, readStoryComposition } from "./story-platform-fixture";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

for (const target of ["deepseek", "chatgpt"]) {
  test.describe(`${target} victory story`, () => {
    const sceneId = `hoc-core/official-story#after-${target}`;
    const modal = (page: Page) => page.locator("[data-story-player]");
    const approved: { speaker: string; segments: { text: string }[] }[] = JSON.parse(readFileSync(new URL(`../../public/characters/official-story/resources/after-${target}.json`, import.meta.url), "utf8")).nodes.filter((node: any) => node.type === "say");
    async function snapshot(page: Page): Promise<any> {
      return page.evaluate(async () => {
        const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
        return (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot();
      });
    }

    /** Controlled result fixture; completion and story triggering still use production UI and persistence. */
    async function settlement(page: Page, opponentId = target, outcome: "victory" | "defeat" | "escaped" = "victory", fresh = true) {
      await page.goto("/");
      await expect(page.locator("[data-start-game]")).toBeEnabled();
      await page.evaluate(async ({ opponentId, outcome, fresh, target }) => {
        const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
        await load("/src/table-screen-module.ts");
        await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
        const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
        const save = fresh ? (await load("/src/persistence/boot.ts")).createDefaultSave() : await repository.loadLongTerm();
        save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
        save.tutorialProgress.completedIds = [...new Set([...save.tutorialProgress.completedIds, "adult-content-warning"])];
        if (fresh) save.defeats = ["llama", ...(target === "chatgpt" ? ["deepseek"] : [])].map(opponentId => ({ opponentId, timestamp: "2026-11-14T00:00:00.000Z" }));
        await repository.saveLongTerm(save);
        const character = await (await load("/src/content/characters/loader.ts")).loadCharacter(opponentId);
        const { definition } = (await load("/src/content/encounters.ts")).invitationProgram(character, save);
        const engine = await load("/src/core/flow/program-engine.ts");
        const run = engine.createProgramRun(`story-result-${Date.now()}`, "story-result-seed", definition);
        const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
        let match = createMatch("story-result-seed", { id: engine.programMatchId(run), opponentId });
        if (outcome === "escaped") match = gameReducer(match, { type: "ESCAPE_MATCH" });
        else {
          const actor = outcome === "victory" ? "opponent" : "player";
          match = { ...match, roulette: { ...match.roulette, [actor]: { ...match.roulette[actor], bullets: match.roulette[actor].capacity } },
            round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: outcome === "victory" ? "player" : "opponent", reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
          match = gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
        }
        await repository.saveRuntime((await load("/src/runtime/program-session.ts")).programSnapshot({ ...run, resources: null }, match));

      }, { opponentId, outcome, fresh, target });
      await page.locator("[data-start-game]").click();
      await expect(page.locator(".summary-shell")).toBeVisible();
      await expect(modal(page)).toHaveCount(0);
      await page.locator('[data-summary-action="lobby"]').click();
    }

    async function advance(page: Page) {
      const cursor = (await snapshot(page)).story.active.run.cursor;
      await modal(page).locator(".story-text").click();
      await expect.poll(async () => (await snapshot(page)).story?.active?.run.cursor ?? null).not.toBe(cursor);
    }
    async function expectFinished(page: Page, status: string) {
      await expect(modal(page)).toHaveCount(0);
      await expect(page.locator(".lobby-menu-shell")).toBeVisible();
      const stored = await snapshot(page);
      expect(stored.runtime?.activeMatch ?? null).toBeNull();
      expect(stored.runtime?.activeProgram ?? null).toBeNull();
      expect(stored.story.completed.filter((entry: any) => entry.sceneId === sceneId)).toEqual([
        expect.objectContaining({ status, receipts: [] })
      ]);
      expect(stored.longTerm.defeats.map((entry: any) => entry.opponentId)).toContain(target);
    }

    test.beforeEach(async ({ page }) => {

      await page.addLocatorHandler(page.locator("[data-acknowledge-third-party-content]"), async button => { await button.click(); });
      await page.addLocatorHandler(page.locator("[data-acknowledge-adult-content]"), async button => { await button.click(); });
      await page.goto("/");
      await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
    });

    test("victory reads all approved dialogue, restores its cursor and finishes without a new table", async ({ page }) => {
      test.setTimeout(120_000);
      await settlement(page);
      await expect(modal(page)).toBeVisible();
      expect((await snapshot(page)).story.active.request.sceneId).toBe(sceneId);
      const checkedArt = new Set<string>();
      for (let index = 0; index < approved.length; index++) {
        const line = approved[index];
        await expect(modal(page).locator(".story-text")).toHaveText(line.segments![0].text!);
        await expect(modal(page).locator(".story-speaker")).toHaveText(line.speaker ?? "");
        const actor = line.speaker === "DeepSeek" ? "deepseek" : line.speaker === "ChatGPT" ? "chatgpt" : undefined;
        if (actor) {
          const image = modal(page).locator(`[data-story-actor="${actor}"]`);
          await expect(image).toBeVisible();
          expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          const src = (await image.getAttribute("src"))!;
          if (!checkedArt.has(src)) {
            checkedArt.add(src);
            for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 1280, height: 800 }]) {
              await page.setViewportSize(viewport);
              const stage = (await modal(page).locator(".story-stage-actors").boundingBox())!;
              const reading = await readStoryComposition(page);
              for (const portrait of reading.actors.filter(actor => actor.visible)) {
                // Protected shoulder/hand region of the inspected full-body sprites.
                expect(portrait.x + portrait.width * .22).toBeGreaterThanOrEqual(-13);
                expect(portrait.x + portrait.width * .80).toBeLessThanOrEqual(reading.width + 13);
                expect(portrait.y + stage.y).toBeLessThanOrEqual(viewport.height * .44);
                expect(portrait.width / portrait.height).toBeCloseTo(portrait.naturalWidth / portrait.naturalHeight, 2);
              }
            }
          }
        }
        if (index === 10) {
          const cursor = (await snapshot(page)).story.active.run.cursor;
          await page.reload(); await page.locator("[data-start-game]").click();
          await expect(modal(page)).toBeVisible();
          expect((await snapshot(page)).story.active.run.cursor).toBe(cursor);
          await expect(modal(page).locator(".story-text")).toHaveText(line.segments![0].text!);
        }
        await advance(page);
      }
      await expectFinished(page, "completed");
      await settlement(page, target, "victory", false);
      await expectFinished(page, "completed");
    });

    for (const status of ["skipped", "interrupted"] as const) {
      test(`${status} returns to the lobby and a later victory never replays it`, async ({ page }) => {
        await settlement(page); await expect(modal(page)).toBeVisible();
        if (status === "skipped") await skipStory(page);
        else {
          await page.keyboard.press("Escape");
          await modal(page).getByRole("button", { name: "退出剧情", exact: true }).click();
        }
        await expectFinished(page, status);
        await settlement(page, target, "victory", false);
        await expectFinished(page, status);
      });
    }

    for (const [opponent, outcome] of [[target, "defeat"], [target, "escaped"], ["llama", "victory"]] as const) {
      test(`${opponent} ${outcome} does not consume the ${target} victory trigger`, async ({ page }) => {
        await settlement(page, opponent, outcome);
        await expect(page.locator(".lobby-menu-shell")).toBeVisible();
        await expect(modal(page)).toHaveCount(0);
        expect((await snapshot(page)).story?.completed?.filter((entry: any) => entry.sceneId === sceneId) ?? []).toEqual([]);
        const recorded = (await snapshot(page)).notebook.characters.find((entry: any) => entry.characterId === opponent);
        expect(recorded?.endings).toContain(outcome === "victory" ? "playerVictory" : outcome === "defeat" ? "playerDefeat" : "escaped");
        await settlement(page, target, "victory", false);
        await expect(modal(page)).toBeVisible();
        expect((await snapshot(page)).story.active.request.sceneId).toBe(sceneId);
      });
    }

  });
}
