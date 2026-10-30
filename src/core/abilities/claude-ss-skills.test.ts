import { afterEach, describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { abilityWorld, createMatch, gameReducer, getActiveBustLimit, getLegalActions, normalizeAbilityHands } from "../match/reducer";
import type { MatchState } from "../match/types";
import { ABILITY_REGISTRY, getAbilityDefinition, instantiateAbility, installAbilityRegistry } from "./registry";
import { isAbilityBlockedByStatus } from "./engine";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));

function fixture(level: number, skill = "claude-ss-moment"): MatchState {
  const base = createMatch("ss-skills", { opponentId: "claude", skillDeckIds: [], opponentAiSkills: [{ definitionId: skill, level, enabled: true, parameters: {} }] });
  const cards = Array.from({ length: 30 }, (_, index) => createCard("spades", index === 3 ? "3" : "2", `ss-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, currentActor: "opponent", phase: "turns", outcome: null } };
}
function opponentTurn(state: MatchState): MatchState { return { ...state, round: { ...state.round, currentActor: "opponent" } }; }
function nextRound(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}
function grant(state: MatchState, id = "situation-assessment"): MatchState {
  const instance = instantiateAbility({ definitionId: id, enabled: true, parameters: {} }, "player", `card-${id}`, state.abilities.sequence + 1, undefined, "player-skill");
  return { ...state, abilities: { ...state.abilities, instances: [...state.abilities.instances, instance], sequence: instance.createdAtSequence }, playerSkills: { ...state.playerSkills, cards: [...state.playerSkills.cards, { kind: "player-skill", owner: "player", definitionId: id, instanceId: instance.instanceId }] } };
}
describe("Claude SS two-level skills", () => {
  it.each([1, 2])("adds the post-Hit half-hand count with floor at Lv2 and one at Lv1: %s", level => {
    let state = fixture(level);
    expect(getActiveBustLimit(state, "player")).toBe(21);
    for (const [index, total] of (level === 2 ? [22, 24, 26, 29] : [22, 23, 24, 25]).entries()) {
      state = gameReducer(opponentTurn(state), { type: "OPPONENT_HIT" });
      expect(state.opponent.hand.cards).toHaveLength(index + 3);
      expect(getActiveBustLimit(state, "player")).toBe(total);
      expect(getActiveBustLimit(state, "opponent")).toBe(total);
    }
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(getActiveBustLimit(saved, "player")).toBe(level === 2 ? 29 : 25);
    expect(getActiveBustLimit(nextRound(saved), "player")).toBe(21);
  });
  it("raises the limit before the same Hit bust check and counts derived cards only on a later real Hit", () => {
    let state = fixture(2);
    const opponent = { ...state.opponent, hand: { cards: [createCard("spades", "10", "ten-a"), createCard("hearts", "10", "ten-b"), createDerivedCard("clubs", "A", "derived")] } };
    state = normalizeAbilityHands({ ...state, opponent, round: { ...state.round, opponent } });
    expect(getActiveBustLimit(state, "opponent")).toBe(21);
    state = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(getActiveBustLimit(state, "opponent")).toBe(23);
    expect(state.opponent.busted).toBe(false);
    const after = gameReducer(state, { type: "PLAYER_HIT" });
    expect(getActiveBustLimit(after, "player")).toBe(23);
  });
  it.each([1, 2])("locks active cards through roulette, but only Lv2 forces Stand: %s", level => {
    const reactionId = "example-roulette-card";
    const base = getAbilityDefinition("situation-assessment")!;
    installAbilityRegistry([...originalRegistry.definitions, { ...base, id: reactionId,
      activation: { type: "action", windows: ["owner-roulette-reaction"], consume: "card" },
      rules: [{ id: "remove-round", trigger: "on-ability-played", effects: [{ type: "remove-gun-bullets", target: "owner", amount: 1 }] }]
    }], originalRegistry.statuses, originalRegistry.catalogVersion);
    const before = grant(grant(fixture(level, "claude-ss-constitution")), reactionId);
    const state = gameReducer(before, { type: "OPPONENT_STAND" });
    expect(state.player.stood).toBe(level === 2);
    expect(state.opponent.stood).toBe(true);
    expect(state.round.phase).toBe(level === 2 ? "round-reveal" : "turns");
    const id = before.playerSkills.cards[0].instanceId;
    expect(getLegalActions(state).some(action => action.type === "PLAY_ABILITY")).toBe(false);
    expect(gameReducer(state, { type: "PLAY_ABILITY", instanceId: id })).toBe(state);
    expect(state.playerSkills.cards).toEqual(before.playerSkills.cards);
    const revealed = level === 1 ? gameReducer(state, { type: "PLAYER_STAND" }) : state;
    const roulette = gameReducer(revealed, { type: "ACK_ROUND_RESULT" });
    expect(roulette.round.phase).toMatch(/^roulette-/);
    const reactionCard = roulette.playerSkills.cards.find(card => card.definitionId === reactionId)!;
    expect(getLegalActions(roulette)).not.toContainEqual({ type: "PLAY_ABILITY", instanceId: reactionCard.instanceId });
    expect(gameReducer(roulette, { type: "PLAY_ABILITY", instanceId: reactionCard.instanceId })).toBe(roulette);
    const unlocked = { ...roulette, round: { ...roulette.round, phase: "roulette-reaction" as const }, abilities: { ...roulette.abilities, statuses: [] } };
    expect(getLegalActions(unlocked)).toContainEqual({ type: "PLAY_ABILITY", instanceId: reactionCard.instanceId });
    // The same lock applies to a real engine reaction window and expires next round.
    const skill = getAbilityDefinition("situation-assessment")!;
    expect(isAbilityBlockedByStatus(abilityWorld(state), "player", skill)).toBe(true);
    const reaction = getAbilityDefinition(reactionId)!;
    expect(isAbilityBlockedByStatus(abilityWorld(state), "player", reaction)).toBe(true);
    if (level === 1) expect(getLegalActions(state)).toContainEqual({ type: "PLAYER_HIT" });
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(isAbilityBlockedByStatus(abilityWorld(saved), "player", skill)).toBe(true);
    expect(isAbilityBlockedByStatus(abilityWorld(nextRound(saved)), "player", skill)).toBe(false);
  });
  it("still locks skills if the player already stood, and never triggers on a forced opponent Stand", () => {
    let state = fixture(2, "claude-ss-constitution");
    state = { ...state, player: { ...state.player, stood: true }, round: { ...state.round, player: { ...state.player, stood: true } } };
    const after = gameReducer(state, { type: "OPPONENT_STAND" });
    expect(after.abilities.statuses.some(status => status.statusDefinitionId === "claude-ss-skill-lock")).toBe(true);
    state = grant(fixture(2, "claude-ss-constitution"), "claude-account-ban");
    state = { ...state, round: { ...state.round, currentActor: "player" } };
    const forced = gameReducer(state, { type: "PLAY_ABILITY", instanceId: "card-claude-account-ban" });
    expect(forced.opponent.stood).toBe(true);
    expect(forced.player.stood).toBe(false);
    expect(forced.abilities.statuses).toHaveLength(0);
  });
});
