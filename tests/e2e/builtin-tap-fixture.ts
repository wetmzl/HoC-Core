import { expect, type Page } from "@playwright/test";
/** Uses real installed role resources; only the initial cards/save are deterministic fixtures. */
export async function mountBuiltinTap(page: Page, id: string, defeated = false, roulette?: { phase: "roulette-reaction" | "roulette-trigger"; actor: "player" | "opponent" }) {
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled(); await page.clock.install();
  await page.evaluate(async ({ id, defeated, roulette }) => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    await load("/src/table-screen-module.ts");
    const source = new (await load("/src/content/packages/content-source.ts")).EmbeddedContentSource({ fetch: window.fetch.bind(window) });
    const packages = (await source.packages()).filter((p: any) => p.packageId === "hoc-core/character-tap");
    const plugins = await (await load("/src/content/packages/plugin-modules.ts")).loadPluginModules({ packages: async () => packages });
    if (plugins.registrations.length !== 1) throw Error("Tap module unavailable");
    (await load("/src/dialogue/registry.ts")).installDialogueRegistry(plugins.dialogueRegistry);
    (await load("/src/dialogue/events.ts")).installDialogueEvents(plugins.eventRegistry);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) }, { dialogueRegistry: plugins.dialogueRegistry });
    const contributions = plugins.registrations.map((p: any) => p.registration.createRuntime({}));
    const { createMatch } = await load("/src/core/match/reducer.ts"), { createCard } = await load("/src/core/blackjack/card.ts");
    const start = createMatch(`builtin-tap-${id}`, { opponentId: id });
    const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", "2", `tap-${i}`));
    const player = { ...start.player, hand: { cards: cards.slice(0, 2) } }, opponent = { ...start.opponent, hand: { cards: cards.slice(2, 4) } };
    const playing = { ...start, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, round: { ...start.round, player, opponent, phase: "turns", currentActor: "player", outcome: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
    const match = defeated ? { ...playing, status: "finished", outcome: { winner: "player", reason: "opponent-killed" }, round: { ...playing.round, phase: "roulette-result", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } }, history: [...playing.history, { type: "TRIGGER_PULLED", actor: "opponent", probability: 1, baseProbability: 1, misfireChance: 0, result: "fired", fired: true }, { type: "PARTICIPANT_KILLED", actor: "opponent" }, { type: "MATCH_FINISHED", reason: "opponent-killed" }] } : roulette ? { ...playing, round: { ...playing.round, phase: roulette.phase, currentActor: null, outcome: { winner: roulette.actor === "opponent" ? "player" : "opponent", reason: "comparison", penaltyTarget: roulette.actor, bulletsAdded: 1 } } } : playing;
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts"), save = createDefaultSave();
    save.skipTutorial = true; save.settings.reducedMotion = true; save.settings.soundEnabled = false; save.tutorialProgress.completedIds.push("adult-content-warning");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService(); await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    void (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {}, contributions });
  }, { id, defeated, roulette });
  await expect(page.locator(".table-bottom")).toBeVisible();
}
