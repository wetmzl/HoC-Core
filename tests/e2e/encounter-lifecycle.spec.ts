import { expect, test } from "@playwright/test";
test.setTimeout(120_000);

test("ordinary settlement keeps the common summary retryable after a failed commit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const { singleMatchProgram } = await load("/src/core/flow/program-templates.ts");
    const { createProgramRun, programMatchId } = await load("/src/core/flow/program-engine.ts");
    const { programSnapshot } = await load("/src/runtime/program-session.ts");
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const repo = createPersistenceService(), save = createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save);
    const run = createProgramRun("ordinary-retry", "ordinary-retry", singleMatchProgram({ opponentId: "llama" }));
    await repo.saveRuntime(programSnapshot({ ...run, resources: null }, gameReducer(createMatch("ordinary-retry", { id: programMatchId(run), opponentId: "llama" }), { type: "ESCAPE_MATCH" })));
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
    const { PersistenceService } = await load("/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.commitMatchResult;
    let fail = true;
    PersistenceService.prototype.commitMatchResult = async function (next: unknown) {
      if (fail) { fail = false; throw new Error("ordinary-commit-failure"); }
      return original.call(this, next);
    };
  });
  const exit = page.locator('[data-summary-action="lobby"]');
  await exit.click();
  await expect(page.locator(".summary-shell [data-encounter-status]")).toContainText("ordinary-commit-failure");
  await expect(exit).toBeEnabled();
  const read = () => page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repo = createPersistenceService();
    return { save: await repo.loadLongTerm(), runtime: await repo.loadRuntime() };
  });
  const pending = await read();
  expect(pending.save!.history).toHaveLength(0);
  expect(pending.runtime!.activeMatch).toBeNull();
  expect(pending.runtime!.activeProgram!.results.at(-1)!.match.status).toBe("finished");
  await exit.click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const finished = await read();
  expect(finished.runtime).toBeNull(); expect(finished.save!.history).toHaveLength(1);
  expect(finished.save!.profile.matchesPlayed).toBe(1); expect(finished.save!.defeats).toEqual([]);
});

test("ordinary invitation creates and restores its table through the program initializer", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save); await repo.deleteRuntime();
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
  await page.locator("[data-enter-duel]").click();
  await page.locator("[data-invite-character]").first().click();
  await page.locator("#profile [data-profile-start]").click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  const read = () => page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    return createPersistenceService().loadRuntime();
  });
  const before = (await read())!;
  expect(before.activeFlow).toBeUndefined(); expect(before.activeChallenge).toBeUndefined();
  expect(before.activeProgram!.status).toBe("match"); expect(before.activeProgram!.resources).toBeNull();
  expect(before.activeProgram!.definition.nodes.find(node => node.id === before.activeProgram!.cursor)?.type).toBe("match");
  expect(before.activeMatch!.roulette.player.capacity).toBe(6);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
  await expect(page.locator(".table-bottom")).toBeVisible();
  const restored = (await read())!;
  expect(restored.activeMatch!.id).toBe(before.activeMatch!.id);
  expect(restored.activeMatch!.playerSkills.cards).toEqual(before.activeMatch!.playerSkills.cards);
  expect(restored.activeMatch!.rng).toEqual(before.activeMatch!.rng);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`ordinary-program-${width}.png`), fullPage: true });
  }
});
