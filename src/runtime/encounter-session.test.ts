import { describe, expect, it } from "vitest";
import trial from "../core/challenge/fixtures/legacy-challenge.json";
import { CHARACTER_CATALOG } from "../content/characters";
import { createChallenge, startEncounter } from "../core/challenge/reducer";
import { ChallengeDefinitionSchema } from "../core/challenge/schema";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import type { RuntimeSave } from "../persistence/schema";
import { validateRuntimeSave } from "../persistence/schema";
import { EncounterSession, challengeSnapshot } from "./encounter-session";
import { challengeFlowRun, flowSnapshot, singleMatchFlow } from "./encounter-snapshot";
import { changeCharacterSkinUnlocks } from "../persistence/skin-unlocks";

const definition = ChallengeDefinitionSchema.parse(trial);
function harness() {
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const saves = { get: () => save, set: (value: typeof save) => { save = value; } };
  const session = new EncounterSession(repository, saves);
  const fresh = () => createChallenge("session-run", definition, definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-26T00:00:00Z" })), CHARACTER_CATALOG);
  return { repository, saves, session, fresh };
}
function result(characterId: string, winner: "player" | "opponent" = "player") {
  const h = harness(), run = startEncounter(h.fresh(), characterId);
  let match = createMatch("session-match", { id: run.encounter!.matchId, opponentId: characterId, playerGun: { capacity: 8, bullets: 4 }, opponentAiSkills: [] });
  const actor = winner === "player" ? "opponent" : "player";
  match = { ...match, roulette: { ...match.roulette, [actor]: { ...match.roulette[actor], bullets: match.roulette[actor].capacity } }, round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
  match = gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  return { ...h, run, match };
}

describe("challenge session transaction ownership", () => {
  it("serializes a skin reward with settlement without losing either durable progress update", async () => {
    const { session, repository, saves, match } = result("chatgpt");
    await session.replace(flowSnapshot(singleMatchFlow(match), match));
    const handle = await session.attach(session.run!, session.match!);
    const appearance = { key: "neutral/character#match", skinId: "original", skins: [{ id: "original", name: "初始" }, { id: "blue", name: "蓝色" }] };
    await Promise.all([
      handle.updateProgress!(save => changeCharacterSkinUnlocks(save, appearance, { blue: true })),
      session.settle()
    ]);
    expect(saves.get().profile.matchesPlayed).toBe(1);
    expect(saves.get().characterSkinUnlocks?.[appearance.key]).toEqual({ blue: true });
    expect((await repository.loadLongTerm())?.characterSkinUnlocks).toEqual(saves.get().characterSkinUnlocks);
    expect((await repository.loadLongTerm())?.profile.matchesPlayed).toBe(1);
  });

  it("does not publish a failed in-match progress mutation", async () => {
    const { session, repository, saves, run, match } = result("chatgpt");
    await session.replace(challengeSnapshot(run, match));
    const handle = await session.attach(session.run!, session.match!);
    const before = saves.get();
    repository.saveLongTerm = async () => { throw new Error("disk full"); };
    await expect(handle.updateProgress!(save => ({ ...save, characterSkinUnlocks: { "neutral/character#match": { blue: true } } }))).rejects.toThrow("disk full");
    expect(saves.get()).toBe(before);
  });
  it("publishes no acknowledged intermediate table when a selection write fails, then retries from restored settlement", async () => {
    const { session, repository, saves, run, match } = result("chatgpt", "opponent");
    await session.replace(challengeSnapshot(run, match));
    const before = session.snapshot!;
    const write = repository.saveRuntime.bind(repository); let fail = true;
    repository.saveRuntime = async snapshot => { if (fail) { fail = false; throw new Error("selection unavailable"); } await write(snapshot); };
    await expect(session.settle()).rejects.toThrow("selection unavailable");
    expect(session.snapshot).toBe(before);
    expect(await repository.loadRuntime()).toEqual(before);
    expect(session.match!.scene).not.toBe("lobby");
    expect(session.match!.status).toBe("finished");
    const restored = new EncounterSession(repository, saves); restored.restore((await repository.loadRuntime())!);
    await restored.settle();
    const selection = (await repository.loadRuntime())!;
    expect(selection.activeMatch).toBeNull();
    expect(selection.activeFlow?.completedNodes).toEqual([]);
    expect(selection.activeFlow?.playerGun).toEqual(match.roulette.player);
    expect(selection.flowMemory?.player?.inventory.cards).toEqual(match.playerSkills.cards);
    expect(repository.runtimeWrites).toHaveLength(2);
    expect(repository.commits).toHaveLength(0);
    expect(repository.runtimeWrites.every(snapshot => !snapshot.activeMatch || snapshot.activeMatch.scene !== "lobby")).toBe(true);
  });
  it("keeps a failed escape playable, ignores table ACK, and invalidates its handle after the successful escape", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const handle = await session.attach(prepared.run, match);
    expect(handle.dispatch({ type: "ACK_MATCH_RESULT" })).toBe(match);
    const write = repository.saveRuntime.bind(repository); let fail = true;
    repository.saveRuntime = async snapshot => { if (fail) { fail = false; throw new Error("escape unavailable"); } await write(snapshot); };
    await expect(session.settle(true)).rejects.toThrow("escape unavailable");
    expect(handle.getState()).toBe(match); expect(handle.getState().status).toBe("active");
    await session.settle(true);
    expect(() => handle.dispatch({ type: "PLAYER_STAND" })).toThrow("牌局已结束");
    const retry = session.prepare("guard:llama")!;
    expect(retry.plan.options.id).not.toBe(match.id);
    expect(retry.plan.options.playerCarryover?.inventory.cards).toEqual(match.playerSkills.cards);
    expect(repository.commits).toHaveLength(0);
  });
  it("serializes double reward clicks once and prevents settlement until every resource was claimed", async () => {
    const { session, repository, run, match } = result("chatgpt");
    await session.replace(challengeSnapshot(run, match));
    await expect(session.settle()).rejects.toThrow("请先领取本场奖励");
    await Promise.all([session.claim("skillDraws"), session.claim("skillDraws")]);
    expect(session.match!.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 3);
    expect(repository.runtimeWrites).toHaveLength(2);
    await session.claim("removeBullets"); await session.claim("pointAdvantage");
    await session.settle();
    expect(session.run!.completedNodes).toEqual(["guard:chatgpt"]);
    expect(session.run!.playerComparisonBonus).toBe(1);
    expect(session.run!.playerGun.bullets).toBe(2);
    expect(repository.commits).toHaveLength(1);
    expect((await repository.loadLongTerm())!.characterDefeatProgress?.counts.chatgpt).toBe(1);
    expect((await repository.loadLongTerm())!.history).toEqual([]);
  });
  it.each(["player", "opponent"] as const)("atomically commits Boss %s results once, leaving a failed commit recoverable", async winner => {
    const { session, repository, saves, run, match } = result("claude", winner);
    await session.replace(challengeSnapshot(run, match)); const before = session.snapshot!;
    const commit = repository.commitMatchResult.bind(repository); let fail = true;
    repository.commitMatchResult = async next => { if (fail) { fail = false; throw new Error("result unavailable"); } await commit(next); };
    await expect(session.settle()).rejects.toThrow("result unavailable");
    expect(session.snapshot).toBe(before); expect(saves.get().profile.matchesPlayed).toBe(0);
    expect(await repository.loadRuntime()).toEqual(before);
    const restored = new EncounterSession(repository, saves); restored.restore((await repository.loadRuntime())!);
    await restored.settle();
    expect(restored.snapshot).toBeNull(); expect(await repository.loadRuntime()).toBeNull();
    expect(saves.get().profile.matchesPlayed).toBe(1); expect(saves.get().history).toHaveLength(1);
    expect(saves.get().profile.wins).toBe(winner === "player" ? 1 : 0);
    expect(saves.get().completedChallenges ?? []).toEqual(winner === "player" ? [definition.id] : []);
    await expect(restored.settle()).rejects.toThrow("当前流程已结束");
    expect(repository.commits).toHaveLength(1);
  });
  it("validates the sole owner of each phase and discards old runtime versions without changing long-term schema", () => {
    const { fresh } = harness(); const run = startEncounter(fresh(), "llama");
    const match = createMatch("phase", { id: run.encounter!.matchId, opponentId: "llama", playerGun: { capacity: 8, bullets: 7 } });
    const snapshot = challengeSnapshot(run, match);
    expect(validateRuntimeSave(snapshot).activeMatch!.roulette.player.bullets).toBe(7);
    const invalid: unknown[] = [
      { ...snapshot, activeChallenge: run },
      { ...snapshot, challengeMemory: { player: null } },
      { ...snapshot, activeMatch: { ...match, scene: "lobby" } },
      { ...snapshot, schemaVersion: 12 },
      { ...challengeSnapshot(fresh(), null), challengeMemory: undefined }
    ];
    for (const value of invalid) expect(() => validateRuntimeSave(value)).toThrow();
    expect(createDefaultSave().schemaVersion).toBe(9);
  });
  it("drains queued table writes before abandoning so late saves cannot recreate a challenge", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const handle = await session.attach(prepared.run, match);
    const write = repository.saveRuntime.bind(repository); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    repository.saveRuntime = async (snapshot: RuntimeSave) => { await gate; await write(snapshot); };
    handle.dispatch({ type: "PLAYER_STAND" });
    const abandoning = session.abandon(); release(); await abandoning; await session.flush();
    expect(await repository.loadRuntime()).toBeNull(); expect(session.snapshot).toBeNull();
    expect(() => handle.getState()).toThrow("牌局已结束");
    await expect(session.attach(prepared.run, match)).rejects.toThrow("牌局已改变");
  });
  it("rejects attachment of an old reward snapshot even when run and encounter IDs still match", async () => {
    const { session, repository, run, match } = result("chatgpt");
    await session.replace(challengeSnapshot(run, match));
    await session.claim("skillDraws");
    const claimed = session.snapshot!;
    await expect(session.attach(challengeFlowRun(run), match)).rejects.toThrow("牌局已改变");
    expect(session.snapshot).toBe(claimed);
    expect((await repository.loadRuntime())!.activeMatch!.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 3);
  });
  it("rechecks attachment inside the write queue after an earlier abandonment", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const abandonment = session.abandon();
    const attachment = session.attach(prepared.run, match);
    await abandonment;
    await expect(attachment).rejects.toThrow("牌局已改变");
    expect(session.snapshot).toBeNull(); expect(await repository.loadRuntime()).toBeNull();
  });
  it("invalidates old handles across rollback and deterministic retry with the same match ID", async () => {
    const { session, repository, fresh, saves } = harness(); await session.begin(challengeFlowRun(fresh()));
    const selection = session.snapshot!, prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const stale = await session.attach(prepared.run, match);
    await session.replace(selection);
    const retry = session.prepare("guard:llama")!;
    expect(retry.plan.options.id).toBe(match.id);
    const active = await session.attach(retry.run, match);
    expect(() => stale.dispatch({ type: "PLAYER_STAND" })).toThrow("牌局已结束");
    expect(() => stale.updateSave({ ...saves.get(), profile: { ...saves.get().profile, displayName: "stale" } })).toThrow("牌局已结束");
    expect(repository.longTermWrites).toHaveLength(0);
    expect(saves.get().profile.displayName).toBe("策展人");
    expect(active.getState()).toBe(match);
  });

  it("exposes valid handle long-term updates immediately so independent settings and tutorial edits compose", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const handle = await session.attach(prepared.run, match);
    const first = handle.getSave();
    handle.updateSave({ ...first, settings: { ...first.settings, pluginSettings: { "fixture:settings": { version: 1, values: { enabled: true } } } } });
    const second = handle.getSave();
    expect(second.settings.pluginSettings).toEqual({ "fixture:settings": { version: 1, values: { enabled: true } } });
    handle.updateSave({ ...second, tutorialProgress: { completedIds: ["fixture:tutorial"] } });
    expect(handle.getSave().tutorialProgress.completedIds).toEqual(["fixture:tutorial"]);
    await handle.flush();
    const durable = (await repository.loadLongTerm())!;
    expect(durable.settings.pluginSettings).toEqual({ "fixture:settings": { version: 1, values: { enabled: true } } });
    expect(durable.tutorialProgress.completedIds).toEqual(["fixture:tutorial"]);
  });

  it("reattaches an unchanged authoritative table even while every runtime write is refused", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const previous = await session.attach(prepared.run, match);
    repository.saveRuntime = async () => { throw new Error("storage offline"); };
    const resumed = await session.attach(session.run!, session.match!);
    expect(resumed.getState()).toBe(match);
    expect(() => previous.getState()).toThrow("牌局已结束");
    expect(repository.runtimeWrites).toHaveLength(2);
    expect((await repository.loadRuntime())!.activeMatch!.id).toBe(match.id);
  });
  it("rejects an old table with unchanged gun and run progress after another table action", async () => {
    const { session, repository, fresh } = harness(); await session.begin(challengeFlowRun(fresh()));
    const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    const handle = await session.attach(prepared.run, match);
    handle.dispatch({ type: "PLAYER_STAND" }); await handle.flush();
    const before = session.snapshot!;
    await expect(session.attach(session.run!, match)).rejects.toThrow("牌局已改变");
    expect(session.snapshot).toBe(before);
    expect(await repository.loadRuntime()).toEqual(before);
  });

});


describe("single encounters use the shared flow session", () => {
  it.each(["player", "opponent"] as const)("keeps a failed ordinary %s settlement retryable and invalidates old handles after commit", async winner => {
    const { match } = result("llama", winner);
    const { session, repository, saves } = harness();
    const handle = await session.attach(undefined, match);
    const pending = session.snapshot!;
    expect(validateRuntimeSave(JSON.parse(JSON.stringify(pending))).activeChallenge).toBeUndefined();
    expect(handle.dispatch({ type: "ACK_MATCH_RESULT" })).toBe(match);
    const commit = repository.commitMatchResult.bind(repository); let fail = true;
    repository.commitMatchResult = async save => { if (fail) { fail = false; throw new Error("ordinary result unavailable"); } await commit(save); };
    await expect(session.settle()).rejects.toThrow("ordinary result unavailable");
    expect(session.snapshot).toBe(pending); expect(saves.get().profile.matchesPlayed).toBe(0);
    expect((await repository.loadRuntime())!.activeMatch!.view).toBe("match-summary");
    await session.settle();
    expect(repository.commits).toHaveLength(1); expect(await repository.loadRuntime()).toBeNull();
    expect(saves.get().profile.matchesPlayed).toBe(1); expect(saves.get().profile.wins).toBe(winner === "player" ? 1 : 0);
    expect(saves.get().defeats.some(record => record.opponentId === "llama")).toBe(winner === "player");
    expect(saves.get().completedChallenges ?? []).toEqual([]);
    expect(() => handle.dispatch({ type: "ACK_MATCH_RESULT" })).toThrow("牌局已结束");
    await expect(session.settle()).rejects.toThrow();
    expect(repository.commits).toHaveLength(1);
  });
  it("restores an ordinary table, persists actions and records escape once without a defeat", async () => {
    const { session, repository, saves } = harness();
    const match = createMatch("shared-single-restore", { opponentId: "llama" });
    await session.attach(undefined, match);
    const restored = new EncounterSession(repository, saves); restored.restore((await repository.loadRuntime())!);
    const handle = await restored.attach(undefined, restored.match!);
    handle.dispatch({ type: "ESCAPE_MATCH" }); await handle.flush();
    expect((await repository.loadRuntime())!.activeMatch!.outcome?.reason).toBe("escaped");
    await restored.settle();
    expect(repository.commits).toHaveLength(1); expect(saves.get().defeats).toEqual([]);
    expect(saves.get().history).toHaveLength(1); expect(await repository.loadRuntime()).toBeNull();
  });
});

it("rejects an ordinary opening queued before an empty session was abandoned", async () => {
  const { session, repository } = harness();
  const abandoning = session.abandon();
  const attaching = session.attach(undefined, createMatch("cancelled-opening", { opponentId: "llama" }));
  await abandoning;
  await expect(attaching).rejects.toThrow("牌局已改变");
  expect(await repository.loadRuntime()).toBeNull();
});
