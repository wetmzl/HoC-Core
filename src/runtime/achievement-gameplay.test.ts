import { expect, it, vi } from "vitest";
import { createCard } from "../core/blackjack/card";
import type { MatchState } from "../core/match/types";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createMatchFactBatch } from "../core/events";
import { AchievementDefinitionSchema } from "../core/achievements/schema";
import { createDefaultSave, createRuntimeSave } from "../persistence/boot";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { PersistenceService } from "../persistence/save-service";
import { AchievementUiRuntime } from "./achievement-ui";
import { AchievementGameplayRuntime, restoreGameplayAchievementSave } from "./achievement-gameplay";

function table(): MatchState {
  const base = createMatch("achievement-transaction", { opponentId: "llama", openingSkillCards: 0, opponentAiSkills: [] });
  const cards = ["10", "Q", "4", "5", "2", "3"].map((rank, index) => createCard("spades", rank as "10", `neutral-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false };
  return { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
    playerSkills: { ...base.playerSkills, drawOffer: null },
    round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "player" as const, outcome: null },
    history: [{ type: "ROUND_STARTED" as const, roundIndex: base.roundIndex }, ...cards.slice(0, 4).map((card, index) => ({
      type: "CARD_DEALT" as const, actor: index < 2 ? "player" as const : "opponent" as const, card, private: true }))] };
}
function entry() {
  const equals = (key: string, value: string | boolean) => ({ type: "value-compare", left: { type: "observation", key }, operator: "eq", right: { type: "literal", value } });
  return { key: "example/achievements#catalog/win", definition: AchievementDefinitionSchema.parse({
    id: "win", revision: 1, name: "中性获胜", description: "完整观察一轮并获胜。", cover: "cover.png",
    tracking: { scope: "round", tracks: [], completeWhen: { type: "all", conditions: [
      equals("event", "round-settled"), equals("winner", "player"), equals("wholeRoundObserved", true)
    ] } }
  }) };
}
async function harness(options: { oldTable?: boolean; debug?: boolean } = {}) {
  const match = table();
  const storage = new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: options.oldTable ? createRuntimeSave(match) : null });
  const repository = new PersistenceService(storage);
  const ui = new AchievementUiRuntime(new MemorySaveStorageDriver(), () => "neutral-stream");
  ui.installCatalog([entry()]);
  const report = vi.fn(async () => undefined);
  const runtime = new AchievementGameplayRuntime({ repository, ui, debugEnabled: () => options.debug === true,
    telemetry: () => ({ recordAchievementUnlocks: report }), now: () => "2026-11-11T08:00:00Z" });
  await runtime.initialize();
  await runtime.flush();
  const unlocked = vi.fn(); ui.subscribeUnlocked(unlocked);
  const save = (before: typeof match | undefined, after: typeof match) => repository.saveRuntime(createRuntimeSave(after), {
    matchFacts: [createMatchFactBatch(before, after)] });
  if (!options.oldTable) await save(undefined, match);
  const stand = gameReducer(match, { type: "PLAYER_STAND" }) as typeof match;
  const settled = gameReducer(stand, { type: "OPPONENT_STAND" }) as typeof match;
  expect(settled.round.outcome?.winner).toBe("player");
  return { storage, repository, ui, runtime, unlocked, report, match, stand, settled, save };
}

it("publishes an actual round unlock only after gameplay, producer cursor and ledger commit together", async () => {
  const h = await harness();
  const write = vi.spyOn(h.storage, "writeSnapshot");
  write.mockRejectedValueOnce(new Error("disk full"));
  await expect(h.save(h.match, h.settled)).rejects.toThrow("disk full");
  expect(h.unlocked).not.toHaveBeenCalled();
  const failed = await h.repository.readSnapshot();
  expect((failed.runtime as ReturnType<typeof createRuntimeSave>).activeMatch?.history).toEqual(h.match.history);
  expect(restoreGameplayAchievementSave(failed.achievements).checkpoint.ledger.records[entry().key]?.completed).toBeUndefined();
  await h.save(h.match, h.settled);
  expect(h.unlocked).toHaveBeenCalledOnce();
  const durable = await h.repository.readSnapshot();
  const achievements = restoreGameplayAchievementSave(durable.achievements);
  expect(achievements.gameplay?.cursor).toBe(h.settled.history.length);
  expect(achievements.checkpoint.ledger.records[entry().key].completed).toBeDefined();
  await h.save(h.match, h.settled);
  await h.runtime.flush();
  expect(h.unlocked).toHaveBeenCalledOnce();
  expect(h.report).toHaveBeenCalledOnce();
  expect(restoreGameplayAchievementSave((await h.repository.readSnapshot()).achievements).checkpoint.pending).toEqual([]);
  h.runtime.dispose();
});

it("restores permanent progress silently and resumes a partially observed round without replay", async () => {
  const h = await harness();
  await h.save(h.match, h.stand); await h.runtime.flush(); h.runtime.dispose();
  const ui = new AchievementUiRuntime(new MemorySaveStorageDriver(), () => "unused-stream"); ui.installCatalog([entry()]);
  const unlocked = vi.fn(); ui.subscribeUnlocked(unlocked);
  const runtime = new AchievementGameplayRuntime({ repository: h.repository, ui });
  await runtime.initialize(); expect(unlocked).not.toHaveBeenCalled();
  await h.save(h.stand, h.settled); await runtime.flush();
  expect(unlocked).toHaveBeenCalledOnce(); runtime.dispose();
  const reopened = new AchievementGameplayRuntime({ repository: h.repository, ui });
  await reopened.initialize(); await reopened.flush();
  expect(unlocked).toHaveBeenCalledOnce();
  expect(ui.snapshot.list.rows[0].status).toBe("completed"); reopened.dispose();
});

it("does not infer a continuously observed round from a legacy restored table", async () => {
  const h = await harness({ oldTable: true });
  await h.save(h.match, h.settled); await h.runtime.flush();
  expect(h.unlocked).not.toHaveBeenCalled(); h.runtime.dispose();
});

it("excludes a debug-assisted attempt and preserves its original completed-state boundary", async () => {
  const h = await harness({ debug: true });
  await h.save(h.match, h.settled); await h.runtime.flush();
  expect(h.unlocked).not.toHaveBeenCalled();
  expect(h.ui.checkpoint?.ledger.records[entry().key].invalidated).toBe(true); h.runtime.dispose();
});

it("abandons active windows on exit while preserving permanent progress and other additive records", async () => {
  const h = await harness();
  await h.repository.projectSnapshot(snapshot => ({ ...snapshot, story: { untouched: true } }), { storyOnly: true });
  await h.repository.deleteRuntime(); await h.runtime.flush();
  const snapshot = await h.repository.readSnapshot();
  const saved = restoreGameplayAchievementSave(snapshot.achievements);
  expect(saved.gameplay).toBeNull(); expect(saved.checkpoint.ledger.windows.match?.status).toBe("abandoned");
  expect(snapshot.story).toEqual({ untouched: true }); h.runtime.dispose();
});

it("retains unreadable achievement bytes without making gameplay saves fail", async () => {
  const storage = new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: null, achievements: { future: "original" } });
  const repository = new PersistenceService(storage);
  const ui = new AchievementUiRuntime(new MemorySaveStorageDriver());
  const runtime = new AchievementGameplayRuntime({ repository, ui });
  await expect(runtime.initialize()).rejects.toThrow();
  const save = createDefaultSave(); await repository.saveLongTerm(save);
  expect((await repository.readSnapshot()).achievements).toEqual({ future: "original" }); runtime.dispose();
});
