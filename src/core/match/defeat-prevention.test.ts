import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { AbilityBinding, AbilityRule } from "../abilities/types";
import { createMatch, gameReducer, getLegalActions } from "./reducer";
import type { Actor, MatchState } from "./types";
import { acknowledgeMatchResult, createDefaultSave, createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { createFlow, finishFlowNode, startFlowNode } from "../flow/reducer";
import { FlowDefinitionSchema } from "../flow/schema";
import { claimGuardVictoryReward, createChallenge, finishEncounter, guardVictoryReward, startEncounter } from "../challenge/reducer";
import { ChallengeDefinitionSchema } from "../challenge/schema";
import { SeededRng } from "../rng/seeded";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
const status = (id: string, duration = "match") => ({ id, defaultDuration: duration, rules: [] });
const ability = (id: string, rules: readonly AbilityRule[]) => ({ id, name: id, description: "Neutral lifecycle fixture", sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["fixture"], activation: { type: "automatic" }, rules });
const protection = (id: string, priority = 0, extra: readonly AbilityRule["effects"][number][] = []) => ability(id, [{
  id: "protect", trigger: "before-defeat", priority, limit: { perMatch: 1 },
  // The interpreter also guards unpreventable pending defeats when content omits a condition.
  effects: [{ type: "prevent-pending-defeat", target: "owner" }, ...extra]
}]);
function install(definitions: readonly unknown[], statuses: readonly unknown[] = []) {
  const playerDefinitions = definitions.map(value => {
    const definition = value as ReturnType<typeof ability>;
    return { ...definition, id: `${definition.id}-player`, sourceKind: "player-skill", hidden: true, drop: { enabled: false, baseWeight: 1 }, stackable: false, skillTags: [definition.primaryDomain] };
  });
  installAbilityRegistry([...registry.definitions, ...definitions, ...playerDefinitions], [...registry.statuses, ...statuses], registry.catalogVersion);
}
function ready(actor: Actor, ids: readonly string[], seed = "neutral-protection"): MatchState {
  const bindings: AbilityBinding[] = ids.map(definitionId => ({ definitionId, enabled: true, parameters: {} }));
  return prepare(createMatch(seed, { opponentId: "chatgpt", unlockedPlayerSkillIds: [], talentIds: [],
    intrinsicAbilities: actor === "player" ? bindings.map(binding => ({ ...binding, definitionId: `${binding.definitionId}-player` })) : [], opponentAiSkills: actor === "opponent" ? bindings : [] }), actor);
}
function prepare(state: MatchState, actor: Actor, bullets = 6): MatchState {
  return { ...state, roulette: { ...state.roulette, [actor]: { capacity: 6, bullets } },
    round: { ...state.round, phase: actor === "player" ? "roulette-reaction" : "roulette-trigger", currentActor: null,
      outcome: { winner: actor === "player" ? "opponent" : "player", reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
}
const fire = (state: MatchState) => gameReducer(state, { type: "TRIGGER_ROULETTE" });
const ack = (state: MatchState) => gameReducer(state, { type: "ACK_TRIGGER_RESULT" });
const restored = (state: MatchState) => validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
const firedRules = (state: MatchState, id: string) => state.history.filter(event => event.type === "ABILITY_TRIGGERED" && (event.definitionId === id || event.definitionId === `${id}-player`));

describe("generic defeat prevention", () => {
  it.each(["player", "opponent"] as const)("keeps a real %s gunshot active, restores, then ends on the next lethal shot", actor => {
    install([protection("fixture-protect", 0, [{ type: "set-status-stacks", target: "owner", statusDefinitionId: "fixture-stage", amount: 2 }, { type: "remove-gun-bullets", target: "owner", amount: 6 }])], [status("fixture-stage")]);
    const before = ready(actor, ["fixture-protect"]), original = structuredClone(before);
    const survived = fire(before);
    expect(before).toEqual(original);
    expect(survived.status).toBe("active"); expect(survived.outcome).toBeUndefined();
    expect(survived.round.phase).toBe("roulette-result");
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "TRIGGER_PULLED", fired: true, result: "fired", actor }));
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "DEFEAT_PREVENTED", actor }));
    expect(survived.history.some(event => ["PARTICIPANT_KILLED", "MATCH_FINISHED", "TRIGGER_SURVIVED"].includes(event.type))).toBe(false);
    expect(getLegalActions(survived)).toContainEqual({ type: "ACK_TRIGGER_RESULT" });
    expect(survived.roulette[actor].bullets).toBe(0);
    const loaded = restored(survived); expect(loaded).toEqual(survived);
    const next = ack(loaded); expect(next.roundIndex).toBe(before.roundIndex + 1); expect(next.round.phase).toBe("turns");
    expect(next.abilities.statuses).toContainEqual(expect.objectContaining({ statusDefinitionId: "fixture-stage", owner: actor, stacks: 2 }));
    expect(gameReducer(next, { type: "ACK_TRIGGER_RESULT" })).toBe(next);
    const final = fire(prepare(next, actor));
    expect(final.status).toBe("finished"); expect(final.outcome?.winner).toBe(actor === "player" ? "opponent" : "player");
    expect(final.history.filter(event => event.type === "MATCH_FINISHED")).toHaveLength(1);
    expect(firedRules(final, "fixture-protect")).toHaveLength(1);
    expect(final.abilities.statuses).toEqual([]);
  });

  it("consumes only the first eligible protection in priority order", () => {
    install([protection("fixture-later", 20), protection("fixture-first", -10)]);
    const first = fire(ready("player", ["fixture-later", "fixture-first"]));
    expect(firedRules(first, "fixture-first")).toHaveLength(1); expect(firedRules(first, "fixture-later")).toHaveLength(0);
    const second = fire(prepare(ack(first), "player"));
    expect(second.status).toBe("active"); expect(firedRules(second, "fixture-later")).toHaveLength(1);
    expect(fire(prepare(ack(second), "player")).status).toBe("finished");
  });

  it("does not spend protection on the rival, empty chambers, misfires, or cancelled pulls", () => {
    install([protection("fixture-protect"), ability("fixture-misfire", [{ id: "misfire", trigger: "before-trigger-pull", effects: [{ type: "add-to-pending-trigger-misfire-chance", target: "owner", amount: 1 }], limit: { perMatch: 1 } }]),
      ability("fixture-cancel", [{ id: "cancel", trigger: "before-trigger-pull", effects: [{ type: "cancel-pending-trigger", target: "owner" }], limit: { perMatch: 1 } }])]);
    for (const ids of [["fixture-protect"], ["fixture-protect", "fixture-misfire"], ["fixture-protect", "fixture-cancel"]]) {
      const before = ready("player", ids);
      const survived = fire(ids.length === 1 ? prepare(before, "player", 0) : before);
      expect(firedRules(survived, "fixture-protect")).toHaveLength(0);
      expect(fire(prepare(survived.round.phase === "roulette-result" ? ack(survived) : survived, "player")).status).toBe("active");
    }
    const opposite = fire(prepare(ready("player", ["fixture-protect"]), "opponent"));
    expect(opposite.status).toBe("finished"); expect(firedRules(opposite, "fixture-protect")).toHaveLength(0);
  });

  it("exposes the real result before defeat and runs post-prevention observers once", () => {
    install([ability("fixture-result", [
      { id: "fired", trigger: "after-trigger-result", conditions: [{ type: "trigger-result-is", value: "fired" }], effects: [{ type: "set-status-stacks", target: "event-actor", statusDefinitionId: "fixture-fired", amount: 1 }] },
      { id: "protect", trigger: "before-defeat", conditions: [{ type: "pending-defeat-can-prevent", target: "owner" }, { type: "status-present", target: "owner", statusDefinitionId: "fixture-fired" }], effects: [{ type: "prevent-pending-defeat", target: "owner" }] },
      { id: "after", trigger: "after-defeat-prevented", effects: [{ type: "set-status-stacks", target: "event-actor", statusDefinitionId: "fixture-after", amount: 1 }] }
    ])], [status("fixture-fired"), status("fixture-after")]);
    const next = fire(ready("opponent", ["fixture-result"]));
    expect(next.status).toBe("active"); expect(firedRules(next, "fixture-result").map(event => event.type === "ABILITY_TRIGGERED" && event.ruleId)).toEqual(["fired", "protect", "after"]);
    expect(next.abilities.statuses.map(status => status.statusDefinitionId)).toEqual(["fixture-fired", "fixture-after"]);
  });

  it("rolls back the whole prevention event when a later effect fails", () => {
    install([protection("fixture-broken", 0, [{ type: "set-status-stacks", target: "owner", statusDefinitionId: "fixture-stage", amount: { type: "power", left: 1e308, right: 2 } }])], [status("fixture-stage")]);
    const before = ready("player", ["fixture-broken"]); const next = fire(before);
    expect(next.status).toBe("finished"); expect(next.abilities.rng).toEqual(before.abilities.rng);
    expect(next.abilities.counters).toEqual(before.abilities.counters);
    expect(next.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(true);
    expect(next.history.some(event => event.type === "DEFEAT_PREVENTED")).toBe(false);
    expect(firedRules(next, "fixture-broken")).toEqual([]);
  });

  it("keeps committed protection when a post-prevention observer fails", () => {
    install([
      protection("fixture-protect", 0, [{ type: "assign-status-values", target: "owner", statusDefinitionId: "fixture-stage", values: { ["phase"]: { type: "numeric", value: 2 } } }]),
      ability("fixture-post-broken", [{ id: "observe", trigger: "after-defeat-prevented", limit: { perMatch: 1 }, effects: [
        { type: "assign-status-values", target: "owner", statusDefinitionId: "fixture-stage", values: { ["phase"]: { type: "numeric", value: 99 } } },
        { type: "add-gun-bullets", target: "owner", amount: { type: "divide", left: 1, right: 0 } }
      ] }])
    ], [status("fixture-stage")]);
    const survived = fire(ready("player", ["fixture-protect", "fixture-post-broken"]));
    expect(survived.status).toBe("active");
    expect(survived.outcome).toBeUndefined();
    expect(survived.history.filter(event => event.type === "DEFEAT_PREVENTED")).toHaveLength(1);
    expect(survived.history.some(event => event.type === "MATCH_FINISHED" || event.type === "PARTICIPANT_KILLED")).toBe(false);
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "ABILITY_RESOLUTION_FAILED", definitionId: "fixture-post-broken-player" }));
    expect(firedRules(survived, "fixture-post-broken")).toEqual([]);
    expect(survived.abilities.statuses.find(entry => entry.statusDefinitionId === "fixture-stage")?.parameters.phase).toBe(2);
    expect(firedRules(survived, "fixture-protect")).toHaveLength(1);
    const next = ack(restored(survived));
    expect(next.abilities.statuses.find(entry => entry.statusDefinitionId === "fixture-stage")?.parameters.phase).toBe(2);
    expect(fire(prepare(next, "player")).status).toBe("finished");
  });

  it("falls through a missed probability without spending the missed protection or its TTL", () => {
    const missed = protection("fixture-missed", -10, [{ type: "remove-gun-bullets", target: "owner", amount: 6 }]);
    const fallback = protection("fixture-fallback", 10);
    install([
      { ...missed, ttl: { type: "triggers", amount: 1 }, rules: missed.rules.map(rule => ({ ...rule, chance: 0 })) },
      { ...fallback, ttl: { type: "triggers", amount: 1 } }
    ]);
    const before = ready("player", ["fixture-missed", "fixture-fallback"]);
    const expectedRng = SeededRng.fromSnapshot(before.abilities.rng); expectedRng.next();
    const survived = fire(before);
    expect(survived.status).toBe("active");
    expect(survived.abilities.rng).toEqual(expectedRng.snapshot());
    expect(survived.roulette.player.bullets).toBe(6);
    expect(firedRules(survived, "fixture-missed")).toEqual([]);
    expect(firedRules(survived, "fixture-fallback")).toHaveLength(1);
    expect(survived.abilities.instances.find(instance => instance.definitionId === "fixture-missed-player")?.ttl?.remaining).toBe(1);
    expect(survived.history.filter(event => event.type === "ABILITY_EXPIRED").map(event => event.type === "ABILITY_EXPIRED" && event.definitionId)).toEqual(["fixture-fallback-player"]);
    expect(fire(prepare(ack(restored(survived)), "player")).status).toBe("finished");
  });

  it("spends one trigger TTL and one probability roll per successful rescue while retaining competitors", () => {
    const first = protection("fixture-first", -10), second = protection("fixture-second", 10);
    install([first, second].map(definition => ({ ...definition, ttl: { type: "triggers", amount: 1 }, rules: definition.rules.map(rule => ({ ...rule, chance: 1 })) })));
    const before = ready("player", ["fixture-first", "fixture-second"]);
    const expectedRng = SeededRng.fromSnapshot(before.abilities.rng); expectedRng.next();
    const survived = fire(before);
    expect(survived.status).toBe("active");
    expect(survived.abilities.rng).toEqual(expectedRng.snapshot());
    expect(survived.abilities.instances.find(instance => instance.definitionId === "fixture-second-player")?.ttl?.remaining).toBe(1);
    expect(survived.history.filter(event => event.type === "ABILITY_EXPIRED").map(event => event.type === "ABILITY_EXPIRED" && event.definitionId)).toEqual(["fixture-first-player"]);
    expect(firedRules(survived, "fixture-second")).toEqual([]);
    const next = ack(restored(survived));
    const secondRng = SeededRng.fromSnapshot(next.abilities.rng); secondRng.next();
    const twice = fire(prepare(next, "player"));
    expect(twice.status).toBe("active");
    expect(twice.abilities.rng).toEqual(secondRng.snapshot());
    expect(firedRules(twice, "fixture-second")).toHaveLength(1);
    expect(fire(prepare(ack(restored(twice)), "player")).status).toBe("finished");
  });

  it("preserves the match lifecycle and expires round state only after acknowledging", () => {
    install([protection("fixture-protect"), ability("fixture-clock", [
      { id: "opening", trigger: "on-match-created", effects: [{ type: "add-skill-draws", target: "owner", amount: 2 }] },
      { id: "round-end", trigger: "on-round-end", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] },
      { id: "round-marker", trigger: "after-defeat-prevented", effects: [{ type: "add-status", target: "owner", statusDefinitionId: "fixture-round" }] }
    ])], [status("fixture-round", "round")]);
    const before = ready("player", ["fixture-protect", "fixture-clock"]);
    const survived = fire(before); expect(survived.playerSkills.drawCount).toBe(before.playerSkills.drawCount);
    expect(survived.abilities.statuses.some(status => status.statusDefinitionId === "fixture-round")).toBe(true);
    const next = ack(survived); expect(next.playerSkills.drawCount).toBe(before.playerSkills.drawCount + 1);
    expect(next.abilities.statuses.some(status => status.statusDefinitionId === "fixture-round")).toBe(false);
    expect(firedRules(next, "fixture-clock").filter(event => event.type === "ABILITY_TRIGGERED" && event.ruleId === "opening")).toHaveLength(1);
  });

  it("does not record progression, advance encounter flows, or offer guard rewards", () => {
    install([protection("fixture-protect")]);
    const flow = FlowDefinitionSchema.parse({ id: "neutral-flow", playerGun: { capacity: 6, bullets: 0 }, nodes: [{ id: "neutral-node", opponentId: "chatgpt", routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } }] });
    const run = startFlowNode(flow, createFlow("neutral-run", "seed"), "neutral-node");
    const survived = fire({ ...ready("opponent", ["fixture-protect"]), id: run.encounter!.matchId });
    expect(finishFlowNode(flow, run, survived)).toBe(run);
    const save = createDefaultSave(); expect(acknowledgeMatchResult(save, survived)).toBe(save);
    const challenge = ChallengeDefinitionSchema.parse({ id: "neutral-challenge", name: "Neutral challenge", description: "Neutral flow", faction: "neutral", bossId: "claude", unlock: { type: "defeat-character", characterId: "chatgpt" }, guards: ["chatgpt", "llama", "gemini", "deepseek"].map(characterId => ({ characterId, suppresses: ["slot"], description: "Neutral guard", victoryRewards: { skillDraws: 3 } })), bossAbilities: [{ slot: "slot", label: "Neutral slot", binding: { definitionId: "fixture-protect", enabled: true, parameters: {} } }] });
    const guard = startEncounter(createChallenge("neutral-guard", challenge, [{ opponentId: "chatgpt", timestamp: "2026-10-26T00:00:00Z" }]), "chatgpt");
    const guardMatch = { ...survived, id: guard.encounter!.matchId };
    expect(finishEncounter(guard, guardMatch)).toBe(guard); expect(guardVictoryReward(guard, guardMatch)).toBeUndefined();
    expect(claimGuardVictoryReward(guard, guardMatch, "skillDraws")).toEqual({ run: guard, match: guardMatch });
  });
});
