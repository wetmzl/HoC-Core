import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCharacter } from "../../content/characters/loader";
import { createCard, createDerivedCard } from "../blackjack/card";
import { handValue, isBlackjack } from "../blackjack/hand";
import type { Rank } from "../blackjack/types";
import { abilityWorld, createMatch, gameReducer, getActiveBustLimit, getRoundHitCounts, normalizeAbilityHands } from "../match/reducer";
import type { MatchState } from "../match/types";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { abilityTriggerNotice } from "../../presentation/ability-notices";
import { resolveDisplays } from "./displays";
import { resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, getAbilityDefinition, installAbilityRegistry, instantiateAbility, createStandaloneAbilityRegistry } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { SeededRng } from "../rng/seeded";
import type { AbilityBinding } from "./types";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));
let bindings: readonly AbilityBinding[];
beforeAll(async () => { bindings = (await loadCharacter("chatgpt")).aiSkills; });

function fixture(playerRanks: Rank[] = ["2", "3"], opponentRanks: Rank[] = ["10", "9"], remaining: Rank[] = ["2", "3", "4", "K", "A", "K"], completedRounds = 1): MatchState {
  let base = createMatch("chatgpt-skills", { opponentId: "chatgpt", opponentAiSkills: bindings, aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
  // Rescue fixtures begin in round two; advance real round boundaries to earn charges.
  for (let i = 0; i < completedRounds; i++) base = advanceRound(base);
  let seq = 0;
  const cards = (ranks: Rank[]) => ranks.map(rank => createCard("spades", rank, `fixture-${++seq}`));
  const player = { ...base.player, hand: { cards: cards(playerRanks) }, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards(opponentRanks) }, bustLimit: undefined };
  const used = [...player.hand.cards, ...opponent.hand.cards];
  return { ...base, player, opponent, shoe: { cards: [...used, ...cards(remaining)], cursor: used.length, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED" as const, roundIndex: base.roundIndex }, ...used.map((card, i) => ({ type: "CARD_DEALT" as const, actor: i < player.hand.cards.length ? "player" as const : "opponent" as const, card, private: i % 2 === 1 }))], round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "player" as const, outcome: null } } satisfies MatchState;
}
function advanceRound(state: MatchState): MatchState {
  return gameReducer({ ...state, playerSkills: { ...state.playerSkills, drawOffer: null }, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}
function charge(state: MatchState): number { return state.abilities.statuses.find(s => s.statusDefinitionId === "chatgpt-reset-charge")?.stacks ?? 0; }
function resetText(state: MatchState) {
  return resolveDisplays(state.abilities, abilityWorld(state), ABILITY_REGISTRY).flatMap(d => d.content).map(n => n.type === "text" ? n.text : n.type === "number" ? n.value : "").join("");
}
function bust(state: MatchState = fixture(["10", "8"], ["10", "9", "5"])) {
  return normalizeAbilityHands(state);
}

// Character integration is Core-owned; the primitives below also use neutral fixtures.
describe("ChatGPT skills", () => {
  it("loads both automatic bindings, exact literary copy and initial RESET display", async () => {
    const character = await loadCharacter("chatgpt");
    expect(character.aiSkills).toHaveLength(2);
    expect(getAbilityDefinition("chatgpt-poker-face")?.profileLore).toBe("能干你就多干点！");
    expect(getAbilityDefinition("chatgpt-reset")?.profileLore).toBe("减半额度，给用户发一次全量重置，就能让他们感恩戴德。");
    const state = fixture(undefined, undefined, undefined, 0);
    expect(charge(state)).toBe(0);
    expect(resetText(state)).toBe("RESET ： 0");
    expect(abilityTriggerNotice(state.history, "ChatGPT", state)).toEqual([]);
  });
  it("settles a first-round bust without RESET", () => {
    const before = fixture(["10", "8"], ["10", "9", "5"], ["2", "3"], 0);
    const after = bust(before);
    expect(charge(after)).toBe(0);
    expect(after.shoe).toEqual(before.shoe);
    expect(after.history.some(e => e.type === "HAND_REDEALT")).toBe(false);
    expect(after.round.outcome?.reason).toBe("bust");
  });
  it("accumulates unused charges across rounds and preserves them in a save", () => {
    let state = fixture(undefined, undefined, undefined, 0);
    for (let round = 1; round <= 3; round++) {
      state = advanceRound(state);
      expect(state.roundIndex).toBe(round);
      expect(charge(state)).toBe(round);
      expect(resetText(state)).toBe(`RESET ： ${round}`);
    }
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch;
    expect(restored).toEqual(state);
    expect(charge(advanceRound(restored))).toBe(4);
  });
  it("spends one accumulated charge per bust, including repeated busts in the same round", () => {
    let state = fixture(["10", "8"], ["10", "9", "5"], ["2", "3", "2", "3", "2", "3"], 3);
    for (let remaining = 2; remaining >= 0; remaining--) {
      const opponent = { ...state.opponent, hand: { cards: [createCard("hearts", "K", `bust-${remaining}-1`), createCard("clubs", "K", `bust-${remaining}-2`), createCard("spades", "5", `bust-${remaining}-3`)] } };
      state = bust({ ...state, opponent, round: { ...state.round, opponent } });
      expect(charge(state)).toBe(remaining);
      expect(state.round.phase).toBe("turns");
      expect(state.roundIndex).toBe(3);
      expect(state.history.filter(e => e.type === "HAND_REDEALT")).toHaveLength(3 - remaining);
    }
    const opponent = { ...state.opponent, hand: { cards: [createCard("hearts", "K", "exhausted-1"), createCard("clubs", "K", "exhausted-2"), createCard("spades", "5", "exhausted-3")] } };
    state = bust({ ...state, opponent, round: { ...state.round, opponent } });
    expect(state.round.outcome?.reason).toBe("bust");
    expect(state.history.filter(e => e.type === "HAND_REDEALT")).toHaveLength(3);
    expect(charge(advanceRound(state))).toBe(1);
  });
  it.each<Rank[]>([["10", "9"], ["A", "K"]])("follows a player Hit even with a high hand %j", (...ranks) => {
    const state = fixture(["2", "3"], ranks, ["2", "2", "4", "5"]);
    const afterPlayer = gameReducer(state, { type: "PLAYER_HIT" });
    const afterAi = gameReducer(afterPlayer, { type: "AI_TURN" });
    expect(afterAi.lastAiDecision?.action).toBe("hit");
    expect(afterAi.lastAiDecision?.actionOverride?.sourceInstanceId).toBeTruthy();
    expect(getRoundHitCounts(afterAi)).toEqual({ player: 1, opponent: 1 });
    expect(afterAi.abilities.statuses.some(s => s.statusDefinitionId === "chatgpt-follow-hit")).toBe(false);
    expect(abilityTriggerNotice(afterAi.history, "ChatGPT", afterAi).some(n => n.text.includes("扑克脸的执行者"))).toBe(true);
  });
  it("follows repeated hits and clears a pending marker when the player stands", () => {
    let state: MatchState = fixture(["2", "2"], ["2", "2"], ["2", "2", "2", "2", "K", "K"]);
    for (let i = 0; i < 2; i++) state = gameReducer(gameReducer(state, { type: "PLAYER_HIT" }), { type: "AI_TURN" });
    expect(getRoundHitCounts(state)).toEqual({ player: 2, opponent: 2 });
    // A turn interception may leave a marker pending until Stand.
    state = gameReducer(state, { type: "PLAYER_HIT" });
    state = { ...state, round: { ...state.round, currentActor: "player" } };
    state = gameReducer(state, { type: "PLAYER_STAND" });
    expect(state.abilities.statuses.some(s => s.statusDefinitionId === "chatgpt-follow-hit")).toBe(false);
    const ai = gameReducer(state, { type: "AI_TURN" });
    expect(ai.lastAiDecision?.actionOverride).toBeUndefined();
  });
  it.each<Rank[]>([["2", "3"], ["10", "9"]])("uses the ordinary threshold after Stand with %j", (...ranks) => {
    const state = gameReducer(gameReducer(fixture(["10", "8"], ranks), { type: "PLAYER_STAND" }), { type: "AI_TURN" });
    expect(state.lastAiDecision?.actionOverride).toBeUndefined();
    expect(state.lastAiDecision?.action).toBe(ranks[0] === "2" ? "hit" : "stand");
  });
  it("does not append an opponent action after the player busts", () => {
    const state = gameReducer(fixture(["10", "9"], ["2", "3"], ["5", "2", "3"]), { type: "PLAYER_HIT" });
    expect(state.round.phase).toBe("round-reveal");
    expect(gameReducer(state, { type: "AI_TURN" })).toEqual(state);
    expect(getRoundHitCounts(state).opponent).toBe(0);
  });
  it("redeals only the owner, preserves physical cards and emits complete initial visibility", () => {
    const before = fixture(["10", "8"], ["10", "9", "5"], ["A", "K", "2"]);
    const after = bust(before);
    expect(after.player).toEqual(before.player);
    expect(after.roulette).toEqual(before.roulette);
    expect(after.roundIndex).toBe(before.roundIndex);
    expect(after.round.currentActor).toBe(before.round.currentActor);
    expect(after.shoe.cards).toEqual(before.shoe.cards);
    expect(after.shoe.cursor).toBe(before.shoe.cursor + 2);
    expect(after.opponent.hand.cards).toEqual(before.shoe.cards.slice(before.shoe.cursor, before.shoe.cursor + 2));
    expect(isBlackjack(after.opponent.hand)).toBe(true);
    expect(after.opponent.busted).toBe(false);
    expect(after.history).not.toContainEqual(expect.objectContaining({ type: "BUST" }));
    const events = after.history.slice(before.history.length);
    expect(events).toContainEqual({ type: "HAND_REDEALT", actor: "opponent", discardedCardIds: before.opponent.hand.cards.map(c => c.id) });
    expect(events.filter(e => e.type === "CARD_DEALT").map(e => e.private)).toEqual([false, true]);
    expect(getRoundHitCounts(after)).toEqual(getRoundHitCounts(before));
    expect(charge(after)).toBe(0);
    expect(resetText(after)).toBe("RESET ： 0");
    expect(after.rng).toEqual(before.rng);
  });
  it("cleans derived cards and settles a second bust normally without another reset", () => {
    let before: MatchState = fixture();
    const opponent = { ...before.opponent, hand: { cards: [...before.opponent.hand.cards, createDerivedCard("hearts", "K", "temporary", "chatgpt-reset")] } };
    before = { ...before, opponent, round: { ...before.round, opponent } };
    const first = bust(before);
    expect(first.opponent.hand.cards.every(c => c.attributes.source === "shoe")).toBe(true);
    expect(first.shoe.cards.some(c => c.id === "temporary")).toBe(false);
    const secondOpponent = { ...first.opponent, hand: { cards: [...first.opponent.hand.cards, createDerivedCard("hearts", "K", "next"), createDerivedCard("clubs", "K", "last")] } };
    const second = bust({ ...first, opponent: secondOpponent, round: { ...first.round, opponent: secondOpponent } });
    expect(second.round.phase).toBe("round-reveal");
    expect(second.round.outcome?.reason).toBe("bust");
    expect(second.history.filter(e => e.type === "HAND_REDEALT")).toHaveLength(1);
  });
  it("keeps the player's Stand and opponent's next turn after an actual Hit causes reset", () => {
    const before = gameReducer(fixture(["10", "8"], ["10", "9"], ["K", "2", "3"]), { type: "PLAYER_STAND" });
    const after = gameReducer(before, { type: "OPPONENT_HIT" });
    expect(after.player.stood).toBe(true);
    expect(after.round.currentActor).toBe("opponent");
    expect(after.round.phase).toBe("turns");
    expect(getRoundHitCounts(after)).toEqual({ player: 0, opponent: 1 });
  });
  it("rolls back the whole rule when fewer than two cards remain", () => {
    const before = fixture(["10", "8"], ["10", "9", "5"], ["2"]);
    const after = bust(before);
    expect(after.shoe).toEqual(before.shoe);
    expect(after.opponent.hand).toEqual(before.opponent.hand);
    expect(charge(after)).toBe(1);
    expect(after.history).toContainEqual(expect.objectContaining({ type: "ABILITY_RESOLUTION_FAILED", definitionId: "chatgpt-reset" }));
    expect(after.history.some(e => e.type === "HAND_REDEALT")).toBe(false);
    expect(after.round.outcome?.reason).toBe("bust");
  });
  it.each(["roulette-result", "round-reveal"] as const)("refills after a new round from %s", start => {
    let state = bust();
    state = { ...state, round: { ...state.round, phase: start, outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } };
    const next = gameReducer(state, { type: start === "roulette-result" ? "ACK_TRIGGER_RESULT" : "ACK_ROUND_RESULT" });
    expect(next.roundIndex).toBe(2);
    expect(charge(next)).toBe(1);
    expect(resetText(next)).toBe("RESET ： 1");
  });
  it("refills after an actual cancelled roulette without publishing a trigger result", () => {
    const definition = { id: "example-cancel", name: "示例取消", description: "示例", sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["example"], activation: { type: "automatic" }, rules: [{ id: "cancel", trigger: "before-trigger-pull", effects: [{ type: "cancel-pending-trigger", target: "owner" }] }] };
    installAbilityRegistry([...originalRegistry.definitions, definition], originalRegistry.statuses, originalRegistry.catalogVersion);
    let state = bust();
    const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", "cancel", state.abilities.sequence + 1, undefined, "ai-skill");
    state = { ...state, abilities: addAbilityInstance(state.abilities, instance), round: { ...state.round, phase: "roulette-trigger", outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
    const next = gameReducer(state, { type: "TRIGGER_ROULETTE" });
    expect(next.roundIndex).toBe(2);
    expect(charge(next)).toBe(1);
    expect(next.history.some(e => e.type === "TRIGGER_PULLED")).toBe(false);
  });
  it("bounds rescue chains even if other content makes each redealt hand bust again", () => {
    const definition = { id: "example-rescue-loop", name: "示例循环", description: "示例", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" }, rules: [
      { id: "redeal", trigger: "before-bust-resolution", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "redeal-initial-hand", target: "owner" }] },
      { id: "break-hand", trigger: "after-hand-changed", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-derived-card", target: "owner", rank: { type: "static", rank: "K" }, suit: { type: "static", suit: "hearts" } }, { type: "add-derived-card", target: "owner", rank: { type: "static", rank: "K" }, suit: { type: "static", suit: "clubs" } }] }
    ] };
    installAbilityRegistry([...originalRegistry.definitions, definition], originalRegistry.statuses, originalRegistry.catalogVersion);
    let state = fixture(["10", "8"], ["10", "9", "5"], Array(40).fill("2"));
    const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", "loop", state.abilities.sequence + 1, undefined, "ai-skill");
    state = { ...state, abilities: { ...addAbilityInstance(state.abilities, instance), statuses: [] } };
    const next = bust(state);
    expect(next.history.filter(e => e.type === "HAND_REDEALT")).toHaveLength(16);
    expect(next.round.outcome?.reason).toBe("bust");
  });
  it("does not consume RESET, cards or RNG while previewing the upper limit", () => {
    for (const ranks of [["10", "9"], ["10", "9", "5"]] as Rank[][]) {
      const state = fixture(["10", "8"], ranks);
      const snapshot = JSON.stringify(state);
      expect(getActiveBustLimit(state, "opponent")).toBe(21);
      expect(getActiveBustLimit(state, "opponent")).toBe(21);
      expect(JSON.stringify(state)).toBe(snapshot);
    }
  });
  it("broadcasts owner hand changes once after redealing, without a new Hit marker", () => {
    let state: MatchState = fixture(["10", "8"], ["10", "9", "5"]);
    const observer = instantiateAbility({ definitionId: "hand-change-observer", enabled: true, parameters: {} }, "opponent", "observer", state.abilities.sequence + 1, undefined, "ai-skill");
    state = { ...state, abilities: addAbilityInstance(state.abilities, observer) };
    const after = bust(state);
    expect(after.history.filter(e => e.type === "ABILITY_TRIGGERED" && e.definitionId === observer.definitionId)).toHaveLength(1);
    expect(after.abilities.statuses.some(s => s.statusDefinitionId === "chatgpt-follow-hit")).toBe(false);
  });
  it("forecasts a dangerous next Hit without consuming a rescue", () => {
    const definition = { id: "example-forecast", name: "示例预演", description: "示例", sourceKind: "ai-skill", primaryDomain: "intelligence-officer", tags: ["example"], activation: { type: "automatic" }, rules: [{ id: "forecast", trigger: "before-ai-decision", conditions: [{ type: "next-hit-would-bust", target: "owner" }], effects: [{ type: "add-to-pending-ai-threshold", target: "owner", amount: 1 }] }] };
    installAbilityRegistry([...originalRegistry.definitions, definition], originalRegistry.statuses, originalRegistry.catalogVersion);
    let state = fixture(["10", "8"], ["10", "9"], ["K", "2", "3"]);
    const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", "forecast", state.abilities.sequence + 1, undefined, "ai-skill");
    state = { ...state, abilities: addAbilityInstance(state.abilities, instance) };
    const after = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "AI_TURN" });
    expect(after.lastAiDecision?.bySkill).toBe(1);
    expect(after.lastAiDecision?.action).toBe("stand");
    expect(after.shoe).toEqual(state.shoe);
    expect(charge(after)).toBe(1);
    expect(after.history.some(e => e.type === "HAND_REDEALT")).toBe(false);
  });
  it("persists overrides and consumed charges, and replays deterministically", () => {
    const state = fixture(["2", "3"], ["10", "9"], ["2", "K", "2", "3", "4"]);
    const next = gameReducer(gameReducer(state, { type: "PLAYER_HIT" }), { type: "AI_TURN" });
    expect(charge(next)).toBe(0);
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(next)))).activeMatch;
    expect(restored).toEqual(next);
    expect(gameReducer(restored, { type: "PLAYER_STAND" })).toEqual(gameReducer(next, { type: "PLAYER_STAND" }));
    expect(gameReducer(gameReducer(state, { type: "PLAYER_HIT" }), { type: "AI_TURN" })).toEqual(next);
    expect(handValue(next.opponent.hand)).toBe(5);
  });
});

// Verify composability without relying on ChatGPT's identifiers or values.
describe("pending AI action primitive", () => {
  it("composes thresholds and uses the final override in standard rule order", () => {
    const definition = { id: "example-action-override", name: "示例", description: "示例", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" }, rules: [
      { id: "first", trigger: "before-ai-decision", priority: -1, effects: [{ type: "set-pending-ai-action", target: "owner", action: "hit" }] },
      { id: "last", trigger: "before-ai-decision", effects: [{ type: "add-to-pending-ai-threshold", target: "owner", amount: 3 }, { type: "set-pending-ai-action", target: "owner", action: "stand" }] }
    ] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const instance = { kind: "ai-skill" as const, definitionId: definition.id, instanceId: "example-instance", owner: "opponent" as const, parameters: {}, createdAtSequence: 1 };
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("example").snapshot()), instance, registry);
    const state = fixture();
    const pending = { id: "example", actor: "opponent" as const, bySkill: 0 };
    const result = resolveAbilityEvent({ world: abilityWorld(state), runtime, registry, event: { trigger: "before-ai-decision", sourceEventId: "example", eventActor: "opponent" }, pendingAiThreshold: pending });
    expect(result.pendingAiThreshold).toEqual({ ...pending, bySkill: 3, actionOverride: { action: "stand", sourceInstanceId: instance.instanceId } });
    expect(result.runtime.rng).toEqual(runtime.rng);
    expect(() => resolveAbilityEvent({ world: abilityWorld(state), runtime, registry, event: { trigger: "before-ai-decision", sourceEventId: "bad" } })).toThrow(/decision window/);
  });
});

it.each(["player", "opponent"] as const)("redeals a neutral ability owner's hand: %s", owner => {
  const definition = { id: "example-redeal", name: "示例重发", description: "示例", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" }, rules: [{ id: "redeal", trigger: "before-bust-resolution", effects: [{ type: "redeal-initial-hand", target: "owner" }] }] };
  const registry = createStandaloneAbilityRegistry([definition], []);
  const instance = { kind: "ai-skill" as const, definitionId: definition.id, instanceId: "example-redeal-instance", owner, parameters: {}, createdAtSequence: 1 };
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("redeal").snapshot()), instance, registry);
  const world = abilityWorld(fixture());
  const result = resolveAbilityEvent({ world, runtime, registry, event: { trigger: "before-bust-resolution", sourceEventId: "redeal", eventActor: owner } });
  expect(result.world.hands[owner].cards).toEqual(world.shoe.cards.slice(world.shoe.cursor, world.shoe.cursor + 2));
  expect(result.world.hands[owner === "player" ? "opponent" : "player"]).toEqual(world.hands[owner === "player" ? "opponent" : "player"]);
  expect(result.world.shoe.cards).toEqual(world.shoe.cards);
  expect(result.world.shoe.cursor).toBe(world.shoe.cursor + 2);
});
