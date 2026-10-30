import { CHARACTER_CATALOG } from "../../content/characters";
import { describe, expect, it } from "vitest";
import trial from "./fixtures/legacy-challenge.json";
import { ChallengeDefinitionSchema, ChallengeRunSchema } from "./schema";
import { createChallenge, startEncounter, finishEncounter, challengeBossAbilities, isChallengeUnlocked, challengeUnlockProgress } from "./reducer";
import { createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { createDefaultSave, createRuntimeSave } from "../../persistence/boot";
import { MemorySaveRepository } from "../../persistence/memory-repository";
import { validateRuntimeSave } from "../../persistence/schema";
import { challengeFlowRun } from "../../runtime/encounter-snapshot";
import { EncounterSession } from "../../runtime/encounter-session";

const definition = ChallengeDefinitionSchema.parse(trial);
const defeats = definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-25T00:00:00Z" }));
const fresh = () => createChallenge("test-run", definition, defeats, CHARACTER_CATALOG);
function completed(characterId: string, winner: "player" | "opponent") {
  const run = startEncounter(fresh(), characterId);
  const match = createMatch("finished-encounter", { id: run.encounter!.matchId, opponentId: characterId, playerGun: { capacity: 8, bullets: 6 } });
  const finished: MatchState = { ...match, status: "finished", scene: "lobby", view: "match-summary", outcome: { winner, reason: winner === "player" ? "opponent-killed" : "player-killed" } };
  return { run, finished };
}
describe("boss challenge state machine", () => {
  it("counts unique defeated members of the exact authored faction, excluding the Boss and unknown characters", () => {
    const faction = "example/factions#one";
    const authored = { ...definition, faction, bossId: "boss", unlock: { type: "defeat-faction-count" as const, count: 4 } };
    const characters = ["a", "b", "c", "d", "boss"].map(id => ({ id, faction })).concat([{ id: "outsider", faction: "example/other#one" }]);
    const records = (ids: string[]) => ids.map(opponentId => ({ opponentId, timestamp: "2026-10-26T00:00:00Z" }));
    const partial = records(["a", "a", "b", "c", "outsider", "boss", "unknown"]);
    expect(challengeUnlockProgress(authored, partial, characters)).toEqual({ current: 3, required: 4, unlocked: false });
    expect(() => createChallenge("blocked", authored, partial, characters)).toThrow("尚未解锁");
    const complete = [...partial, ...records(["d"])];
    expect(challengeUnlockProgress(authored, complete, characters)).toEqual({ current: 4, required: 4, unlocked: true });
    expect(isChallengeUnlocked({ ...authored, unlock: { type: "defeat-faction-count", count: 3 } }, partial, characters)).toBe(true);
    expect(isChallengeUnlocked(authored, complete)).toBe(false);
  });
  it("unlocks from durable unique defeats, not replay counts", () => {
    expect(isChallengeUnlocked(definition, [], CHARACTER_CATALOG)).toBe(false);
    expect(() => createChallenge("locked", definition, [], CHARACTER_CATALOG)).toThrow("尚未解锁");
    expect(isChallengeUnlocked({ ...definition, unlock: { type: "defeat-count", count: 2 } }, [defeats[0], defeats[0]])).toBe(false);
    expect(isChallengeUnlocked({ ...definition, unlock: { type: "defeat-character", characterId: "chatgpt" } }, defeats)).toBe(true);
  });
  it("allows the boss immediately without clearing any guard", () => {
    const run = startEncounter(fresh(), definition.bossId);
    expect(run.encounter?.kind).toBe("boss");
    expect(challengeBossAbilities(run).filter(binding => binding.enabled)).toHaveLength(4);
    expect(startEncounter(run, "chatgpt")).toBe(run);
  });
  it("returns from a guard loss with a full gun, without any weakening", () => {
    const { run, finished } = completed("chatgpt", "opponent");
    const next = finishEncounter(run, finished);
    expect(next.phase).toBe("selection");
    expect(next.result).toBeNull();
    expect(next.playerGun).toEqual({ capacity: 8, bullets: 6 });
    expect(next.defeatedGuards).toEqual([]);
    expect(startEncounter(next, "llama").encounter?.kind).toBe("guard");
    const restarted = startEncounter(next, "chatgpt");
    expect(restarted.encounter?.matchId).not.toBe(run.encounter?.matchId);
  });
  it("weakens only the defeated guard's slots, once, without mutating content", () => {
    const { run, finished } = completed("chatgpt", "player");
    const next = finishEncounter(run, finished);
    expect(next.defeatedGuards).toEqual(["chatgpt"]);
    expect(challengeBossAbilities(next).map(binding => binding.enabled)).toEqual([true, true, true, true]);
    expect(challengeBossAbilities(next).map(binding => binding.level)).toEqual([1, 2, 2, 2]);
    expect(definition.bossAbilities[0].binding.enabled).toBe(true);
    expect(startEncounter(next, "chatgpt")).toBe(next);
    expect(finishEncounter(next, finished)).toBe(next);
    expect(finishEncounter(run, { ...finished, id: "stale" })).toBe(run);
  });
  it.each(["player", "opponent"] as const)("terminates the run for a boss result: %s", winner => {
    const { run, finished } = completed(definition.bossId, winner);
    const next = finishEncounter(run, finished);
    expect(next.phase).toBe("finished");
    expect(next.result).toBe(winner === "player" ? "victory" : "defeat");
    expect(startEncounter(next, "chatgpt")).toBe(next);
  });
  it("guard withdrawal returns to selection; boss withdrawal terminates", () => {
    for (const characterId of ["chatgpt", definition.bossId]) {
      const { run, finished } = completed(characterId, "player");
      const next = finishEncounter(run, { ...finished, outcome: { winner: null, reason: "escaped" } });
      expect(next.defeatedGuards).toEqual([]);
      expect(next.phase).toBe(characterId === definition.bossId ? "finished" : "selection");
    }
  });
  it("still removes a slot when no weakened binding is declared", () => {
    const { run, finished } = completed("chatgpt", "player");
    const legacy = { ...run, definition: { ...run.definition, bossAbilities: run.definition.bossAbilities.map(({ weakenedBinding: _unused, ...ability }) => ability) } };
    expect(challengeBossAbilities(finishEncounter(legacy, finished))[0].enabled).toBe(false);
  });
  it("rejects unknown, duplicate or mismatched guards and skill slots", () => {
    expect(ChallengeDefinitionSchema.safeParse({ ...definition, guards: definition.guards.slice(1) }).success).toBe(false);
    expect(ChallengeDefinitionSchema.safeParse({ ...definition, guards: Array(4).fill(definition.guards[0]) }).success).toBe(false);
    expect(ChallengeRunSchema.safeParse({ ...fresh(), defeatedGuards: ["missing"] }).success).toBe(false);
    expect(startEncounter(fresh(), "unknown").phase).toBe("selection");
  });
  it("creates carried guns before play, preserves full chambers and remains deterministic", () => {
    const options = { opponentId: "llama", playerGun: { capacity: 6, bullets: 6 } };
    const a = createMatch("carried", options);
    expect(a.roulette.player).toEqual(options.playerGun);
    expect(a.roulette.opponent.bullets).toBe(0);
    expect(createMatch("carried", options)).toEqual(a);
    expect(createMatch("ordinary").roulette.player.bullets).toBe(0);
    expect(() => createMatch("invalid", { playerGun: { capacity: 6, bullets: 7 } })).toThrow();
  });
  it("persists selection independently, and keeps challenge encounters out of ordinary rewards", async () => {
    const save = createDefaultSave();
    const repository = new MemorySaveRepository({ longTerm: save });
    const run = startEncounter(fresh(), "chatgpt");
    const match = createMatch("challenge-save", { id: run.encounter!.matchId, opponentId: "chatgpt", playerGun: run.playerGun });
    const session = new EncounterSession(repository, { get: () => save, set: () => {} });
    await session.begin(challengeFlowRun(fresh()));
    const controller = await session.attach(challengeFlowRun(run), match);
    controller.dispatch({ type: "ESCAPE_MATCH" });
    controller.dispatch({ type: "ACK_MATCH_RESULT" });
    await controller.flush();
    expect(repository.commits).toHaveLength(0);
    expect(controller.getSave().defeats).toEqual([]);
    const runtime = (await repository.loadRuntime())!;
    expect(runtime.activeFlow?.playerGun).toBeUndefined();
    expect(runtime.challengeMemory).toBeUndefined();
    expect(runtime.activeMatch!.scene).not.toBe("lobby");
    expect(() => validateRuntimeSave({ ...runtime, activeChallenge: run })).toThrow();
    expect(() => validateRuntimeSave({ ...runtime, activeMatch: { ...runtime.activeMatch!, scene: "lobby" } })).toThrow();
    await session.settle();
    const selection = (await repository.loadRuntime())!;
    expect(selection.activeMatch).toBeNull();
    expect(selection.activeFlow?.phase).toBe("selection");
    expect(validateRuntimeSave(JSON.parse(JSON.stringify(selection))).activeFlow?.playerGun).toEqual(match.roulette.player);
    expect(() => validateRuntimeSave({ ...selection, activeMatch: match })).toThrow();
    expect(() => validateRuntimeSave({ ...runtime, activeMatch: null })).toThrow();
    expect(() => validateRuntimeSave({ ...createRuntimeSave(match), schemaVersion: 12 })).toThrow();
  });
  it("a full chamber still fires through the real match reducer", () => {
    let match = createMatch("full-chamber", { opponentId: "llama", playerGun: { capacity: 6, bullets: 6 } });
    match = { ...match, round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "opponent", reason: "comparison", penaltyTarget: "player", bulletsAdded: 1 } } };
    const fired = gameReducer(match, { type: "TRIGGER_ROULETTE" });
    expect(fired.outcome?.reason).toBe("player-killed");
    expect(fired.roulette.player.bullets).toBe(6);
  });
});
