import { CHARACTER_CATALOG } from "../../content/characters";
import { describe, expect, it } from "vitest";
import trial from "./fixtures/legacy-challenge.json";
import { ChallengeDefinitionSchema, type ChallengeRun } from "./schema";
import { createChallenge, startEncounter, claimGuardVictoryReward, guardVictoryReward, finishEncounter } from "./reducer";
import { createMatch, gameReducer } from "../match/reducer";
import { EncounterSession, challengeSnapshot } from "../../runtime/encounter-session";
import { createDefaultSave } from "../../persistence/boot";
import { PersistenceService } from "../../persistence/save-service";
import type { RawSaveSnapshot } from "../../persistence/storage-driver";

const definition = ChallengeDefinitionSchema.parse(trial);
function fixture(boss = false, previous?: ChallengeRun, guardId = "chatgpt") {
  const run = startEncounter(previous ?? createChallenge("reward", definition, definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: new Date().toISOString() })), CHARACTER_CATALOG), boss ? "claude" : guardId);
  let match = createMatch("reward", { id: run.encounter!.matchId, opponentId: run.encounter!.characterId, playerGun: previous?.playerGun ?? { capacity: 8, bullets: 4 }, comparisonBonuses: { player: run.playerComparisonBonus, opponent: 0 } });
  match = { ...match, roulette: { ...match.roulette, opponent: { capacity: 6, bullets: 6 } }, round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
  match = gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  return { run, match };
}
const kinds = ["skillDraws", "removeBullets", "pointAdvantage"] as const;
function claimAll(run: ChallengeRun, match: ReturnType<typeof createMatch>) {
  let result = { run, match };
  for (const kind of kinds) result = claimGuardVictoryReward(result.run, result.match, kind);
  return result;
}
describe("guard settlement resource claims", () => {
  it("claims each resource separately, only once, without changing the other resources", () => {
    const { run, match } = fixture();
    expect(guardVictoryReward(run, match)).toEqual({ skillDraws: 3, removeBullets: 2, pointAdvantage: 1 });
    const draws = claimGuardVictoryReward(run, match, "skillDraws");
    expect(draws.run.encounter?.claimedRewards).toEqual(["skillDraws"]);
    expect(draws.match.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 3);
    expect(draws.match.roulette.player.bullets).toBe(4); expect(draws.run.playerComparisonBonus).toBe(0);
    expect(claimGuardVictoryReward(draws.run, draws.match, "skillDraws")).toEqual(draws);
    expect(claimGuardVictoryReward(draws.run, draws.match, "skillDraws").run).toBe(draws.run);
    expect(claimGuardVictoryReward(draws.run, draws.match, "skillDraws").match).toBe(draws.match);
    const bullets = claimGuardVictoryReward(draws.run, draws.match, "removeBullets");
    expect(bullets.match.roulette.player.bullets).toBe(2);
    expect(bullets.match.playerSkills.drawCount).toBe(draws.match.playerSkills.drawCount);
    expect(bullets.run.playerComparisonBonus).toBe(0);
    const advantage = claimGuardVictoryReward(bullets.run, bullets.match, "pointAdvantage");
    expect(advantage.run.playerComparisonBonus).toBe(1);
    expect(advantage.match.roulette.player.bullets).toBe(2);
    expect(advantage.match.playerSkills.drawCount).toBe(draws.match.playerSkills.drawCount);
    expect(advantage.run.encounter?.claimedRewards).toEqual([...kinds]);
    expect(advantage.match.playerSkills.cards).toEqual(match.playerSkills.cards);
    expect(advantage.match.abilities).toEqual(match.abilities);
    for (const kind of kinds) expect(claimGuardVictoryReward(advantage.run, advantage.match, kind)).toEqual(advantage);
    expect(run.encounter?.claimedRewards).toBeUndefined();
  });
  it("clamps bullets at zero and stacks only the claimed advantages across guard victories", () => {
    const first = fixture();
    for (const bullets of [0, 1]) {
      const claimed = claimGuardVictoryReward(first.run, { ...first.match, roulette: { ...first.match.roulette, player: { capacity: 8, bullets } } }, "removeBullets");
      expect(claimed.match.roulette.player.bullets).toBe(0); expect(claimed.run.playerComparisonBonus).toBe(0);
      expect(claimed.match.playerSkills.drawCount).toBe(first.match.playerSkills.drawCount);
    }
    const claimed = claimAll(first.run, first.match);
    const selection = finishEncounter(claimed.run, gameReducer(claimed.match, { type: "ACK_MATCH_RESULT" }));
    expect(selection.playerComparisonBonus).toBe(1);
    const second = fixture(false, selection, "llama");
    expect(second.match.comparisonBonuses).toEqual({ player: 1, opponent: 0 });
    const twice = claimAll(second.run, second.match);
    expect(twice.run.playerComparisonBonus).toBe(2); expect(twice.run.playerGun.bullets).toBe(0);
    expect(claimAll(twice.run, twice.match)).toEqual(twice);
    expect(createChallenge("fresh", definition, definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: new Date().toISOString() })), CHARACTER_CATALOG).playerComparisonBonus).toBe(0);
    expect(createMatch("ordinary", { opponentId: "llama" }).comparisonBonuses).toBeUndefined();
  });
  it("rejects losses, escape, stale matches, Boss results, missing/unknown rewards and overflow", () => {
    const { run, match } = fixture();
    for (const invalid of [{ ...match, id: "stale" }, { ...match, status: "active" as const }, { ...match, outcome: { winner: "opponent" as const, reason: "player-killed" as const } }, { ...match, outcome: { winner: null, reason: "escaped" as const } }]) {
      expect(claimGuardVictoryReward(run, invalid, "skillDraws").match).toBe(invalid);
      expect(claimGuardVictoryReward(run, invalid, "skillDraws").run).toBe(run);
    }
    const boss = fixture(true); expect(guardVictoryReward(boss.run, boss.match)).toBeUndefined();
    const noReward = { ...run, definition: { ...run.definition, guards: run.definition.guards.map(({ victoryRewards: _reward, ...guard }) => guard) } };
    expect(claimGuardVictoryReward(noReward, match, "skillDraws").run).toBe(noReward);
    expect(claimGuardVictoryReward(run, match, "unknown" as never).run).toBe(run);
    expect(claimGuardVictoryReward(run, { ...match, playerSkills: { ...match.playerSkills, drawCount: Number.MAX_SAFE_INTEGER } }, "skillDraws").run).toBe(run);
  });
  it("atomically saves partial receipts and lets the remaining resources be claimed after restore", async () => {
    const { run, match } = fixture(), longTerm = createDefaultSave();
    let raw: RawSaveSnapshot = { longTerm, runtime: null }, fail = false;
    const repo = new PersistenceService({ readSnapshot: async () => structuredClone(raw), writeSnapshot: async next => {
      if (fail) { fail = false; throw new Error("reward write failed"); }
      raw = structuredClone(next);
    } });
    const session = new EncounterSession(repo, { get: () => longTerm, set: () => {} });
    await session.replace(challengeSnapshot(run, match));
    fail = true;
    await expect(session.claim("skillDraws")).rejects.toThrow("reward write failed");
    expect(session.match).toBe(match);
    expect((await repo.loadRuntime())!.activeChallenge!.encounter!.claimedRewards).toBeUndefined();
    await session.claim("skillDraws");
    const restored = (await repo.loadRuntime())!;
    expect(restored.activeMatch!.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 3);
    expect(restored.activeMatch!.roulette.player.bullets).toBe(4);
    expect(restored.activeFlow!.playerComparisonBonus).toBe(0);
    expect(restored.activeFlow!.encounter!.claimedRewards).toEqual(["skillDraws"]);
    expect(restored.activeFlow).not.toHaveProperty("playerGun");
    expect(restored).not.toHaveProperty("flowMemory");
    const resumed = new EncounterSession(repo, { get: () => longTerm, set: () => {} });
    resumed.restore(restored);
    await resumed.claim("skillDraws");
    expect(resumed.match!.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 3);
    await resumed.claim("pointAdvantage");
    expect((await repo.loadRuntime())!.activeFlow!.playerComparisonBonus).toBe(1);
    await resumed.claim("removeBullets");
    const claimed = (await repo.loadRuntime())!;
    expect(claimed.activeFlow!.encounter!.claimedRewards).toEqual(["skillDraws", "pointAdvantage", "removeBullets"]);
    expect(claimed.activeMatch!.roulette.player.bullets).toBe(2);
    await resumed.settle();
    const final = (await repo.loadRuntime())!;
    expect(final.activeMatch).toBeNull();
    expect(final.activeFlow!.completedNodes).toEqual(["guard:chatgpt"]);
    expect(final.activeFlow!.playerGun).toEqual({ capacity: 8, bullets: 2 });
    expect(final.flowMemory!.player!.inventory.drawCount).toBe(match.playerSkills.drawCount + 3);
    const durable = (await repo.loadLongTerm())!;
    expect(durable.profile).toEqual(longTerm.profile);
    expect(durable.history).toEqual(longTerm.history);
    expect(durable.defeats).toEqual(longTerm.defeats);
    expect(durable.characterDefeatProgress?.counts.chatgpt).toBe(1);
  });
});
