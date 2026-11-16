import { expect, test } from "@playwright/test";

test("default gameplay runtime unlocks an installed achievement and restores its UI silently", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/v1/events", route => route.abort());
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const evidence = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const save = createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await createPersistenceService().saveLongTerm(save);
    // Use the ordinary composition root, including its default achievement attachment.
    // Only accepted match facts are injected; no achievement ledger or connection is forged.
    const { createGameRuntime } = await load("/src/runtime/create-game-runtime.ts");
    const { mountAchievementUi } = await load("/src/presentation/achievement-ui.ts");
    const root = document.querySelector<HTMLDivElement>("#app")!;
    const disposeUi = mountAchievementUi(root), game = createGameRuntime();
    const handle = await game.mountGameRuntime({ root, onExitRequest: async () => {} });
    (window as any).__gameplayAchievementFixture = { game, handle, disposeUi };
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { createMatchFactBatch } = await load("/src/core/events/index.ts");
    const { createProgramRun, programMatchId } = await load("/src/core/flow/program-engine.ts");
    const { singleMatchProgram } = await load("/src/core/flow/program-templates.ts");
    const { programSnapshot } = await load("/src/runtime/program-session.ts");
    const program = { ...createProgramRun("browser-achievement", "browser-achievement", singleMatchProgram({ opponentId: "llama" })), resources: null };
    const base = createMatch("browser-achievement", { id: programMatchId(program), opponentId: "llama", opponentAiSkills: [], openingSkillCards: 0 });
    const cards = ["10", "Q", "4", "5", "2", "3"].map((rank, index) => createCard("spades", rank, `achievement-${index}`));
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false };
    const initial = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
      playerSkills: { ...base.playerSkills, drawOffer: null },
      round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null },
      history: [{ type: "ROUND_STARTED", roundIndex: 0 }, ...cards.slice(0, 4).map((card, index) => ({
        type: "CARD_DEALT", actor: index < 2 ? "player" : "opponent", card, private: true }))] };
    const persist = (before: any, after: any) => game.repository.saveRuntime(programSnapshot(program, after), {
      matchFacts: [createMatchFactBatch(before, after)] });
    await persist(undefined, initial);
    const stood = gameReducer(initial, { type: "PLAYER_STAND" }); await persist(initial, stood);
    const settled = gameReducer(stood, { type: "OPPONENT_STAND" }); await persist(stood, settled);
    const snapshot = await game.repository.readSnapshot();
    const records = snapshot.achievements.checkpoint.ledger.records;
    const key = Object.keys(records).find(key => key.endsWith("/fair-play"))!;
    return { key, completion: records[key].completed, cursor: snapshot.achievements.gameplay.cursor,
      historyLength: settled.history.length, winner: settled.round.outcome.winner };
  });
  expect(evidence.winner).toBe("player"); expect(evidence.completion).toBeDefined();
  expect(evidence.key).toBe("hoc-core/official-built-in-achievements#achievements/fair-play");
  expect(evidence.cursor).toBe(evidence.historyLength);
  await expect(page.locator(".achievement-toast")).toContainText("公平竞技倡导");
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-start-game]").click();
  await expect(page.locator(".table-playing")).toBeVisible();
  await expect(page.locator(".achievement-toast")).toHaveCount(0);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    (await load("/src/presentation/achievement-ui.ts")).openAchievementOverview();
  });
  const row = page.locator(`.achievement-overview [data-achievement-key="${evidence.key}"]`);
  await expect(row).toHaveClass(/is-completed/); await expect(row).toContainText("公平竞技倡导");
  await expect(row.locator(".achievement-cover img")).toHaveAttribute("src", /official-built-in-achievements\/covers\/fair-play\.png$/);
  await expect.poll(() => row.locator(".achievement-cover img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
  const restored = await page.evaluate(async key => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createPersistenceService } = await load("/src/persistence/factory.ts");
    const snapshot = await createPersistenceService().readSnapshot();
    return snapshot.achievements.checkpoint.ledger.records[key].completed;
  }, evidence.key);
  expect(restored).toEqual(evidence.completion); expect(errors).toEqual([]);
});
