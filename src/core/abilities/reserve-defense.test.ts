import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { createCard } from "../blackjack/card";
import { createHand } from "../blackjack/hand";
import { createMatch, gameReducer } from "../match/reducer";
import type { Actor, MatchState } from "../match/types";
import { ABILITY_REGISTRY, installAbilityRegistry } from "./registry";
import type { AbilityRule, AiSkillAbilityDefinition, PlayerSkillAbilityDefinition, ScalarValue, StatusDefinition } from "./types";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const reserveId = "example-renewable-reserve";
const protectionId = "example-round-protection";
const reserveValue = (key: string): ScalarValue => ({ type: "status-number", target: "owner", statusDefinitionId: reserveId, key });
const reserveDefinition = (misfire = false): AiSkillAbilityDefinition => ({
  id: "example-renewable-defense", name: "Renewable reserve", description: "Neutral renewable protection composition", sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["reserve"], activation: { type: "automatic" },
  rules: [
    { id: "initialize", trigger: "on-match-created", effects: [
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["ready"]: { type: "numeric", value: 1 } } },
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["cooldown"]: { type: "numeric", value: 0 } } }
    ] },
    { id: "renew", trigger: "on-round-start", effects: [
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["cooldown"]: { type: "numeric", value: { type: "max", left: 0, right: { type: "subtract", left: reserveValue("cooldown"), right: 1 } } } } },
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["ready"]: { type: "numeric", value: { type: "max", left: 0, right: { type: "subtract", left: 1, right: reserveValue("cooldown") } } } } }
    ] },
    { id: "protect", trigger: "before-defeat", conditions: [{ type: "pending-defeat-can-prevent", target: "owner" }, { type: "scalar-compare", left: reserveValue("ready"), operator: "gte", right: 1 }], effects: [
      { type: "prevent-pending-defeat", target: "owner" },
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["ready"]: { type: "numeric", value: 0 } } },
      { type: "assign-status-values", target: "owner", statusDefinitionId: reserveId, values: { ["cooldown"]: { type: "numeric", value: 2 } } }
    ] },
    ...(misfire ? [{ id: "misfire-once", trigger: "before-trigger-pull", limit: { perMatch: 1 }, effects: [{ type: "add-to-pending-trigger-misfire-chance", target: "owner", amount: 1 }] } as AbilityRule] : [])
  ],
  displays: [{ id: "reserve", target: "owner", description: "Public ready reserve", density: "compact", content: [{ type: "meter", value: reserveValue("ready"), max: 1 }] }]
});
const roundDefense: PlayerSkillAbilityDefinition = {
  id: "example-active-defense", name: "Round protection", description: "Neutral active round protection composition", sourceKind: "player-skill", primaryDomain: "gunslinger", skillTags: ["gunslinger"], tags: ["protection"], drop: { enabled: true, baseWeight: 1 }, stackable: false, acquisitionLimit: { perMatch: 1 },
  activation: { type: "action", windows: ["owner-turn", "owner-roulette-reaction"], consume: "card" },
  rules: [{ id: "activate", trigger: "on-ability-played", effects: [{ type: "add-status", target: "owner", statusDefinitionId: protectionId }] }]
};
const roundProtection: StatusDefinition = {
  id: protectionId, defaultDuration: "round", rules: [{ id: "protect", trigger: "before-defeat", conditions: [{ type: "pending-defeat-can-prevent", target: "status-owner" }], effects: [{ type: "prevent-pending-defeat", target: "status-owner" }] }]
};

function fixture(definition: AiSkillAbilityDefinition | PlayerSkillAbilityDefinition): MatchState {
  const isAi = definition.sourceKind === "ai-skill";
  installAbilityRegistry([...original.definitions, definition], [...original.statuses, { id: reserveId, defaultDuration: "match", rules: [] }, roundProtection], original.catalogVersion);
  const base = createMatch("neutral-reserve-defense", { opponentId: "chatgpt", skillDeckIds: [], unlockedPlayerSkillIds: isAi ? [] : [definition.id], talentIds: [], opponentAiSkills: isAi ? [{ definitionId: definition.id, enabled: true, parameters: {} }] : [] });
  const cards = Array.from({ length: 44 }, (_, index) => createCard("clubs", "2", `neutral-reserve-card-${index}`));
  const player = { ...base.player, hand: createHand(cards.slice(0, 2)), stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: createHand(cards.slice(2, 4)), stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}
function prepare(state: MatchState, actor: Actor, bullets = 6): MatchState {
  return { ...state, roulette: { ...state.roulette, [actor]: { capacity: 6, bullets } }, round: { ...state.round, phase: actor === "player" ? "roulette-reaction" : "roulette-trigger", currentActor: null, outcome: { winner: actor === "player" ? "opponent" : "player", reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
}
const fire = (state: MatchState) => gameReducer(state, { type: "TRIGGER_ROULETTE" });
const ack = (state: MatchState) => gameReducer(state, { type: "ACK_TRIGGER_RESULT" });
const restored = (state: MatchState) => validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
const reserve = (state: MatchState) => state.abilities.statuses.find(status => status.statusDefinitionId === reserveId)?.parameters;
function activateDefense(): MatchState {
  const state = fixture(roundDefense);
  const granted = gameReducer({ ...state, playerSkills: { ...state.playerSkills, drawCount: 1, drawOffer: { id: "neutral-defense-offer", candidateDefinitionIds: [roundDefense.id], refreshesRemaining: 0 } } }, { type: "SELECT_SKILL_DRAW", definitionId: roundDefense.id });
  expect(granted.playerSkills.cards).toHaveLength(1);
  return gameReducer(granted, { type: "PLAY_ABILITY", instanceId: granted.playerSkills.cards[0].instanceId });
}

describe("neutral reserve and round-defense compositions", () => {
  it("renews a spent defense after two new-round decrements, preserving cooldown across saves", () => {
    const initial = fixture(reserveDefinition());
    expect(reserve(initial)).toMatchObject({ ready: 1, cooldown: 0 });
    const first = fire(prepare(initial, "opponent"));
    expect(first.status).toBe("active");
    expect(reserve(first)).toMatchObject({ ready: 0, cooldown: 2 });
    const next = ack(restored(first));
    expect(next.roundIndex).toBe(initial.roundIndex + 1);
    expect(reserve(next)).toMatchObject({ ready: 0, cooldown: 1 });
    const unavailable = fire(prepare(next, "opponent"));
    expect(unavailable.status).toBe("finished");
    expect(unavailable.history.filter(event => event.type === "DEFEAT_PREVENTED")).toHaveLength(1);
    // Take a separate safe continuation to reach the second renewal boundary.
    const empty = fire(prepare(next, "opponent", 0));
    expect(reserve(empty)).toMatchObject({ ready: 0, cooldown: 1 });
    const renewed = ack(restored(empty));
    expect(renewed.roundIndex).toBe(initial.roundIndex + 2);
    expect(reserve(renewed)).toMatchObject({ ready: 1, cooldown: 0 });
    const second = fire(prepare(renewed, "opponent"));
    expect(second.status).toBe("active");
    expect(second.history.filter(event => event.type === "DEFEAT_PREVENTED")).toHaveLength(2);
    expect(reserve(second)).toMatchObject({ ready: 0, cooldown: 2 });
  });

  it.each(["empty", "misfire"] as const)("does not spend a ready reserve on an %s result", mode => {
    const initial = fixture(reserveDefinition(mode === "misfire"));
    const survived = fire(prepare(initial, "opponent", mode === "empty" ? 0 : 6));
    expect(survived.status).toBe("active");
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "TRIGGER_PULLED", result: mode === "empty" ? "empty-chamber" : "misfire", fired: false }));
    expect(survived.history.some(event => event.type === "DEFEAT_PREVENTED")).toBe(false);
    expect(reserve(survived)).toMatchObject({ ready: 1, cooldown: 0 });
    const fired = fire(prepare(ack(survived), "opponent"));
    expect(fired.status).toBe("active");
    expect(reserve(fired)).toMatchObject({ ready: 0, cooldown: 2 });
  });

  it("retains a consumed active card's status source, prevents a real shot, and expires next round", () => {
    const activated = activateDefense();
    expect(activated.playerSkills.cards).toEqual([]);
    expect(activated.playerSkills.acquisitionCounts?.[roundDefense.id]).toBe(1);
    const status = activated.abilities.statuses.find(entry => entry.statusDefinitionId === protectionId)!;
    expect(status.duration).toBe("round");
    expect(activated.abilities.instances.some(instance => instance.instanceId === status.sourceInstanceId)).toBe(true);
    const survived = fire(prepare(restored(activated), "player"));
    expect(survived.status).toBe("active");
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "TRIGGER_PULLED", fired: true, actor: "player" }));
    expect(survived.history).toContainEqual(expect.objectContaining({ type: "DEFEAT_PREVENTED", actor: "player", sourceInstanceId: status.sourceInstanceId }));
    const next = ack(restored(survived));
    expect(next.abilities.statuses.some(entry => entry.statusDefinitionId === protectionId)).toBe(false);
    expect(next.abilities.instances.some(instance => instance.instanceId === status.sourceInstanceId)).toBe(false);
    expect(next.playerSkills.acquisitionCounts?.[roundDefense.id]).toBe(1);
    expect(fire(prepare(next, "player")).status).toBe("finished");
  });

  it("expires an unused active defense at the same boundary", () => {
    const activated = activateDefense();
    const empty = fire(prepare(activated, "player", 0));
    expect(empty.abilities.statuses.some(entry => entry.statusDefinitionId === protectionId)).toBe(true);
    const next = ack(empty);
    expect(next.abilities.statuses.some(entry => entry.statusDefinitionId === protectionId)).toBe(false);
    expect(fire(prepare(next, "player")).status).toBe("finished");
  });
});
