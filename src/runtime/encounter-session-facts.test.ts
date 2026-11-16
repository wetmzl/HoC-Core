import { describe, expect, it } from "vitest";
import trial from "../core/challenge/fixtures/legacy-challenge.json";
import { CHARACTER_CATALOG } from "../content/characters";
import { createChallenge, startEncounter } from "../core/challenge/reducer";
import { ChallengeDefinitionSchema } from "../core/challenge/schema";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { EncounterSession, challengeSnapshot } from "./encounter-session";
import type { MatchFactDelivery } from "./match-fact-runtime";

function harness() {
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const saves = { get: () => save, set: (next: typeof save) => { save = next; } };
  const session = new EncounterSession(repository, saves);
  const delivered: MatchFactDelivery[] = [];
  session.events.subscribe("committed", batch => { delivered.push(batch); });
  return { repository, saves, session, delivered };
}

function collectFactIds(session: EncounterSession): void {
  session.events.registerProjector((checkpoint, batch) => batch.facts.length ? { ...checkpoint,
    longTerm: { ...checkpoint.longTerm, tutorialProgress: {
      completedIds: [...new Set([...checkpoint.longTerm.tutorialProgress.completedIds, ...batch.facts.map(fact => fact.id)])]
    } } } : checkpoint);
}

describe("legacy encounter fact checkpoints", () => {
  it("commits initial facts and their projection together, and restores without replay", async () => {
    const { repository, saves, session, delivered } = harness();
    collectFactIds(session);
    const match = createMatch("legacy-fact-initial", { opponentId: "llama", openingSkillCards: 0 });
    await session.attach(undefined, match);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].fromIndex).toBe(0);
    expect(delivered[0].facts).toHaveLength(match.history.length);
    expect(repository.commits).toHaveLength(1);
    expect((await repository.loadRuntime())?.activeMatch).toEqual(match);
    expect((await repository.loadLongTerm())?.tutorialProgress).toEqual(saves.get().tutorialProgress);
    const restored = new EncounterSession(repository, saves);
    let projected = 0;
    restored.events.registerProjector(checkpoint => { projected++; return checkpoint; });
    const restoredBatches: MatchFactDelivery[] = [];
    restored.events.subscribe("committed", batch => { restoredBatches.push(batch); });
    restored.restore((await repository.loadRuntime())!);
    await restored.flush();
    await restored.attach(undefined, restored.match!);
    expect(projected).toBe(0);
    expect(restoredBatches).toHaveLength(2);
    expect(restoredBatches.every(batch => batch.restored && !batch.facts.length && !batch.events.length)).toBe(true);
    expect(repository.commits).toHaveLength(1);
  });

  it("retries uncommitted action facts with the next checkpoint and notifies only after success", async () => {
    const { repository, saves, session, delivered } = harness();
    const match = createMatch("legacy-fact-retry", { opponentId: "llama", openingSkillCards: 0 });
    const handle = await session.attach(undefined, match);
    delivered.length = 0;
    collectFactIds(session);
    const commit = repository.commitMatchResult.bind(repository);
    repository.commitMatchResult = async () => { throw new Error("checkpoint unavailable"); };
    const first = handle.dispatch({ type: "PLAYER_STAND" });
    const firstBatch = handle.getLastFactBatch!()!;
    await expect(handle.flush()).rejects.toThrow("checkpoint unavailable");
    expect(delivered).toEqual([]);
    expect(saves.get().tutorialProgress.completedIds).toEqual([]);
    expect((await repository.loadRuntime())?.activeMatch).toEqual(match);
    repository.commitMatchResult = commit;
    const second = handle.dispatch({ type: "OPPONENT_STAND" });
    expect(second).not.toBe(first);
    const latestUiBatch = handle.getLastFactBatch!()!;
    expect(latestUiBatch.fromIndex).toBe(first.history.length);
    await handle.flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].fromIndex).toBe(match.history.length);
    expect(delivered[0].facts.map(fact => fact.id)).toEqual([...firstBatch.facts, ...latestUiBatch.facts].map(fact => fact.id));
    expect(saves.get().tutorialProgress.completedIds).toEqual(delivered[0].facts.map(fact => fact.id));
    expect((await repository.loadRuntime())?.activeMatch).toEqual(second);
    expect(repository.commits).toHaveLength(1);
  });

  it("preserves the newest accepted table while earlier writes and projections are awaiting storage", async () => {
    const { repository, session, delivered } = harness();
    const match = createMatch("legacy-fact-queue", { opponentId: "llama", openingSkillCards: 0 });
    const handle = await session.attach(undefined, match);
    delivered.length = 0;
    collectFactIds(session);
    const commit = repository.commitMatchResult.bind(repository);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    repository.commitMatchResult = async (save, runtime) => { await gate; await commit(save, runtime); };
    const first = handle.dispatch({ type: "PLAYER_STAND" });
    const second = handle.dispatch({ type: "OPPONENT_STAND" });
    expect(handle.getState()).toBe(second);
    release(); await handle.flush();
    expect(handle.getState()).toBe(second);
    expect((await repository.loadRuntime())?.activeMatch).toEqual(second);
    expect(delivered.map(batch => [batch.fromIndex, batch.toIndex])).toEqual([
      [match.history.length, first.history.length], [first.history.length, second.history.length]
    ]);
  });

  it.each([false, true])("retries failed action facts when reattaching an optimistic table (reconciled copy: %s)", async copied => {
    const { repository, saves, session, delivered } = harness();
    const match = createMatch("legacy-fact-reattach", { opponentId: "llama", openingSkillCards: 0 });
    const handle = await session.attach(undefined, match);
    delivered.length = 0;
    collectFactIds(session);
    const commit = repository.commitMatchResult.bind(repository);
    repository.commitMatchResult = async () => { throw new Error("checkpoint unavailable"); };
    const accepted = handle.dispatch({ type: "PLAYER_STAND" });
    const acceptedFacts = handle.getLastFactBatch!()!.facts;
    await expect(handle.flush()).rejects.toThrow("checkpoint unavailable");
    expect(delivered).toEqual([]);
    expect((await repository.loadRuntime())?.activeMatch).toEqual(match);
    const reconciled = copied ? { ...accepted, abilities: { ...accepted.abilities } } : accepted;
    repository.commitMatchResult = commit;
    const rebound = await session.attach(session.run!, reconciled, accepted);
    expect(rebound.getState()).toBe(reconciled);
    expect((await repository.loadRuntime())?.activeMatch).toEqual(reconciled);
    expect(saves.get().tutorialProgress.completedIds).toEqual(acceptedFacts.map(fact => fact.id));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].restored).toBe(false);
    expect(delivered[0].fromIndex).toBe(match.history.length);
    expect(delivered[0].facts).toEqual(acceptedFacts);
    expect(repository.commits).toHaveLength(1);
    // Only this successfully persisted reference may take the offline resume path.
    repository.saveRuntime = async () => { throw new Error("offline"); };
    repository.commitMatchResult = async () => { throw new Error("offline"); };
    await session.attach(session.run!, reconciled);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({ restored: true, facts: [], events: [] });
    expect(repository.commits).toHaveLength(1);
  });

  it("does not publish failed withdrawal facts and commits the successful escape/ack batch once", async () => {
    const { repository, session, delivered } = harness();
    const definition = ChallengeDefinitionSchema.parse(trial);
    const run = startEncounter(createChallenge("legacy-fact-flow", definition,
      definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-26T00:00:00Z" })), CHARACTER_CATALOG), "llama");
    const match = createMatch("legacy-fact-withdraw", { opponentId: "llama", id: run.encounter!.matchId, openingSkillCards: 0 });
    await session.replace(challengeSnapshot(run, match));
    const write = repository.saveRuntime.bind(repository);
    repository.saveRuntime = async () => { throw new Error("withdraw unavailable"); };
    await expect(session.settle(true)).rejects.toThrow("withdraw unavailable");
    expect(delivered).toEqual([]);
    expect(session.match).toBe(match);
    repository.saveRuntime = write;
    await session.settle(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map(event => event.type)).toEqual(["MATCH_ESCAPED", "MATCH_FINISHED", "MATCH_RESULT_ACKNOWLEDGED"]);
    expect(delivered[0].after.scene).toBe("lobby");
  });

  it("routes legacy reward state changes without inventing events and keeps abandonment silent on failure", async () => {
    const { repository, session, delivered } = harness();
    const definition = ChallengeDefinitionSchema.parse(trial);
    const run = startEncounter(createChallenge("legacy-fact-reward-flow", definition,
      definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-26T00:00:00Z" })), CHARACTER_CATALOG), "chatgpt");
    const initial = createMatch("legacy-fact-reward", { opponentId: "chatgpt", id: run.encounter!.matchId, openingSkillCards: 0 });
    const pending = { ...initial, roulette: { ...initial.roulette, opponent: { capacity: 6, bullets: 6 } },
      round: { ...initial.round, phase: "roulette-trigger" as const, currentActor: null,
        outcome: { winner: "player" as const, reason: "comparison" as const, penaltyTarget: "opponent" as const, bulletsAdded: 1 } } };
    const won = gameReducer(gameReducer(pending, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
    await session.replace(challengeSnapshot(run, won));
    await session.claim("skillDraws");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].facts).toEqual([]);
    expect(delivered[0].after.playerSkills.drawCount).toBeGreaterThan(won.playerSkills.drawCount);
    const remove = repository.deleteRuntime.bind(repository);
    repository.deleteRuntime = async () => { throw new Error("delete unavailable"); };
    await expect(session.abandon()).rejects.toThrow("delete unavailable");
    expect(delivered).toHaveLength(1);
    repository.deleteRuntime = remove;
    await session.abandon();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].facts).toEqual([]);
    expect(delivered[1].after.outcome).toEqual(won.outcome);
    expect(session.snapshot).toBeNull();
    await session.dispose();
  });
});
