import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCharacter } from "../../content/characters/loader";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { abilityTriggerNotice } from "../../presentation/ability-notices";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { abilityWorld, createMatch, gameReducer, getActiveBustLimit, getLegalActions, getRoundHitCounts, normalizeAbilityHands, previewComparisonScores } from "../match/reducer";
import type { Actor, MatchState } from "../match/types";
import { isActionBlockedByStatus } from "./engine";
import { ABILITY_REGISTRY, installAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance } from "./runtime";
import { StatusDefinitionSchema } from "./schema";
import type { AbilityBinding, DecisionAction, StatusDuration } from "./types";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));
let bindings: readonly AbilityBinding[];
beforeAll(async () => { bindings = (await loadCharacter("claude")).aiSkills; });

function fixture(playerRanks: Rank[] = ["2", "3"], opponentRanks: Rank[] = ["10", "9"], remaining: Rank[] = ["2", "3", "2", "2", "K"], withSkills = true): MatchState {
  const base = createMatch("claude-skills", { opponentId: "claude", opponentAiSkills: withSkills ? bindings : [], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
  let sequence = 0;
  const cards = (ranks: Rank[]) => ranks.map(rank => createCard("spades", rank, `claude-fixture-${++sequence}`));
  const player = { ...base.player, hand: { cards: cards(playerRanks) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards(opponentRanks) }, stood: false, busted: false, bustLimit: undefined };
  const used = [...player.hand.cards, ...opponent.hand.cards];
  return { ...base, player, opponent, shoe: { cards: [...used, ...cards(remaining)], cursor: used.length, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }], round: { ...base.round, player, opponent, currentActor: "player", phase: "turns", outcome: null } };
}
function turn(state: MatchState, actor: Actor): MatchState { return { ...state, round: { ...state.round, currentActor: actor } }; }
function nextRound(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}
function block(state: MatchState, actor: Actor, actions: DecisionAction[], duration: StatusDuration = "round", stacks = 1): MatchState {
  const definition = { id: "example-action-block", name: "示例动作封锁", description: "示例", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" }, rules: [] };
  const status = { id: "example-blocked-actions", defaultDuration: duration, blocksActions: actions, rules: [] };
  installAbilityRegistry([...originalRegistry.definitions, definition], [...originalRegistry.statuses, status], originalRegistry.catalogVersion);
  const source = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, actor === "player" ? "opponent" : "player", "example-block-source", state.abilities.sequence + 1, undefined, "ai-skill");
  const runtime = addAbilityInstance(state.abilities, source);
  return { ...state, abilities: { ...runtime, statuses: [...runtime.statuses, { statusDefinitionId: status.id, owner: actor, sourceInstanceId: source.instanceId, stacks, duration, parameters: {}, createdAtSequence: runtime.sequence }] } };
}

describe("Claude skills", () => {
  it("does not raise the shared limit on the initial deal, player Hits or derived hand changes", () => {
    const initial = createMatch("claude-initial", { opponentAiSkills: bindings });
    expect(getActiveBustLimit(initial, "player")).toBe(21);
    expect(getActiveBustLimit(initial, "opponent")).toBe(21);
    const hit = gameReducer(fixture(), { type: "PLAYER_HIT" });
    const opponent = { ...hit.opponent, hand: { cards: [...hit.opponent.hand.cards, createDerivedCard("hearts", "A", "example-derived")] } };
    const changed = normalizeAbilityHands({ ...hit, opponent, round: { ...hit.round, opponent } });
    expect(getActiveBustLimit(changed, "player")).toBe(21);
    expect(getActiveBustLimit(changed, "opponent")).toBe(21);
  });
  it("raises the shared limit before checking the Hit that would otherwise bust, and counts every actual Hit", () => {
    let state = gameReducer(fixture(), { type: "PLAYER_STAND" });
    state = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(state.round.phase).toBe("turns");
    expect(state.opponent.busted).toBe(false);
    expect(getActiveBustLimit(state, "player")).toBe(22);
    expect(getActiveBustLimit(state, "opponent")).toBe(22);
    const notices = abilityTriggerNotice(state.history, "Claude", state);
    expect(notices).toContainEqual(expect.objectContaining({ text: "Claude发动「克劳德时刻」：本轮公共爆牌上限提高至22点。" }));
    state = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(getRoundHitCounts(state).opponent).toBe(2);
    expect(getActiveBustLimit(state, "player")).toBe(23);
    expect(getActiveBustLimit(state, "opponent")).toBe(23);
    expect(state.round.outcome?.reason).toBe("bust");
  });
  it("lets both participants use the raised public limit and still rejects a genuine bust", () => {
    let state = gameReducer(turn(fixture(["10", "10"], ["10", "10"], ["2", "2", "K"]), "opponent"), { type: "OPPONENT_HIT" });
    state = gameReducer(state, { type: "PLAYER_HIT" });
    expect(state.player.busted).toBe(false);
    expect(state.opponent.busted).toBe(false);
    expect(previewComparisonScores(state).baseScores).toEqual({ player: 22, opponent: 22 });
    expect(gameReducer(state, { type: "OPPONENT_HIT" }).opponent.busted).toBe(true);
  });
  it("makes 22 beat a natural Blackjack and preserves ordinary shared-limit comparison", () => {
    let state = gameReducer(turn(fixture(["A", "K"], ["10", "10"], ["2"]), "opponent"), { type: "OPPONENT_HIT" });
    state = gameReducer(state, { type: "PLAYER_STAND" });
    state = gameReducer(state, { type: "OPPONENT_STAND" });
    expect(state.round.outcome).toMatchObject({ winner: "opponent", reason: "comparison", comparisonScores: { player: 21, opponent: 22 } });
  });
  it("uses the raised limit for aces even when the ordinary 21-point total did not bust", () => {
    const state = gameReducer(turn(fixture(["A", "A"], ["10", "10"], ["2"]), "opponent"), { type: "OPPONENT_HIT" });
    const snapshot = JSON.stringify(state);
    expect(previewComparisonScores(state).baseScores).toEqual({ player: 22, opponent: 22 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
  it("blocks Hit only after Claude explicitly Stands, leaving Stand and skill draw legal", () => {
    const before = turn(fixture(), "opponent");
    expect(isActionBlockedByStatus(abilityWorld(before), "player", "hit")).toBe(false);
    const stood = gameReducer(before, { type: "OPPONENT_STAND" });
    const after = { ...stood, playerSkills: { ...stood.playerSkills, drawCount: 1 } };
    expect(getLegalActions(after)).not.toContainEqual({ type: "PLAYER_HIT" });
    expect(getLegalActions(after)).toContainEqual({ type: "PLAYER_STAND" });
    expect(getLegalActions(after)).toContainEqual({ type: "OPEN_SKILL_DRAW" });
    expect(gameReducer(after, { type: "PLAYER_HIT" })).toBe(after);
    expect(gameReducer(after, { type: "PLAYER_STAND" }).round.phase).toBe("round-reveal");
    expect(abilityTriggerNotice(after.history, "Claude", after)).toContainEqual(expect.objectContaining({ text: "Claude发动「安全宪法」：玩家本轮无法再选择 Hit。" }));
  });
  it("does not trigger the constitution on 21, player Stand, or an opponent bust", () => {
    for (const state of [
      gameReducer(turn(fixture(), "opponent"), { type: "OPPONENT_HIT" }),
      gameReducer(fixture(), { type: "PLAYER_STAND" }),
      gameReducer(turn(fixture(["2", "3"], ["10", "10"], ["K"]), "opponent"), { type: "OPPONENT_HIT" })
    ]) expect(state.abilities.statuses.some(status => status.statusDefinitionId === "claude-safety-no-hit")).toBe(false);
  });
  it("restores both mechanics from a runtime save and clears them at the next round or escape", () => {
    let state = gameReducer(turn(fixture(["2", "3"], ["10", "10"], ["2"]), "opponent"), { type: "OPPONENT_HIT" });
    state = gameReducer(turn(state, "opponent"), { type: "OPPONENT_STAND" });
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch;
    expect(getActiveBustLimit(saved, "player")).toBe(22);
    expect(gameReducer(saved, { type: "PLAYER_HIT" })).toBe(saved);
    const next = nextRound(saved);
    expect(getActiveBustLimit(next, "player")).toBe(21);
    expect(getActiveBustLimit(next, "opponent")).toBe(21);
    expect(isActionBlockedByStatus(abilityWorld(next), "player", "hit")).toBe(false);
    expect(gameReducer(saved, { type: "ESCAPE_MATCH" }).abilities.statuses).toEqual([]);
  });
});

describe("generic Hit/Stand status restrictions", () => {
  it.each(["hit", "stand"] as const)("enforces blocked player %s atomically and only for the affected actor", action => {
    const state = block(fixture(["2", "3"], ["2", "3"], ["2"], false), "player", [action]);
    const request = { type: action === "hit" ? "PLAYER_HIT" : "PLAYER_STAND" } as const;
    expect(getLegalActions(state)).not.toContainEqual(request);
    expect(gameReducer(state, request)).toBe(state);
    expect(isActionBlockedByStatus(abilityWorld(state), "opponent", action)).toBe(false);
    const alternate = action === "hit" ? { type: "PLAYER_STAND" } as const : { type: "PLAYER_HIT" } as const;
    expect(getLegalActions(state)).toContainEqual(alternate);
    expect(gameReducer(state, alternate)).not.toBe(state);
  });
  it.each(["hit", "stand"] as const)("blocks both opponent %s aliases and makes automatic AI choose the remaining legal action", action => {
    const state = block(turn(fixture(["2", "3"], action === "hit" ? ["2", "3"] : ["10", "9"], ["2"], false), "opponent"), "opponent", [action]);
    for (const type of action === "hit" ? ["AI_HIT", "OPPONENT_HIT"] as const : ["AI_STAND", "OPPONENT_STAND"] as const) expect(gameReducer(state, { type })).toBe(state);
    const next = gameReducer(state, { type: "AI_TURN" });
    expect(next.lastAiDecision?.action).toBe(action === "hit" ? "stand" : "hit");
    expect(next.history).not.toContainEqual(expect.objectContaining({ type: action === "hit" ? "OPPONENT_HIT" : "OPPONENT_STOOD" }));
  });
  it("offers no AI turn and does not advance a fully blocked actor", () => {
    const state = block(turn(fixture(undefined, undefined, undefined, false), "opponent"), "opponent", ["hit", "stand"]);
    expect(getLegalActions(state)).not.toContainEqual({ type: "AI_TURN" });
    expect(gameReducer(state, { type: "AI_TURN" })).toBe(state);
    expect(getLegalActions(state)).toContainEqual({ type: "ESCAPE_MATCH" });
  });
  it("keeps action restrictions authoritative over a declarative AI override", async () => {
    const character = await loadCharacter("chatgpt");
    const base = fixture(["2", "3"], ["10", "9"], ["2"], false);
    const runtime = createMatch("example-override", { opponentAiSkills: character.aiSkills }).abilities;
    const hit = gameReducer({ ...base, abilities: runtime }, { type: "PLAYER_HIT" });
    const next = gameReducer(block(hit, "opponent", ["hit"]), { type: "AI_TURN" });
    expect(next.lastAiDecision?.actionOverride?.action).toBe("hit");
    expect(next.lastAiDecision?.action).toBe("stand");
    expect(getRoundHitCounts(next).opponent).toBe(0);
  });
  it("uses the status lifecycle and ignores zero stacks", () => {
    let state = block(fixture(undefined, undefined, undefined, false), "player", ["stand"], "until-owner-action");
    state = gameReducer(state, { type: "PLAYER_HIT" });
    expect(isActionBlockedByStatus(abilityWorld(state), "player", "stand")).toBe(false);
    expect(isActionBlockedByStatus(abilityWorld(block(fixture(undefined, undefined, undefined, false), "player", ["hit"], "round", 0)), "player", "hit")).toBe(false);
  });
  it("strictly validates the closed blocked-action vocabulary", () => {
    const base = { id: "example-actions", rules: [], defaultDuration: "round" };
    for (const blocksActions of [["hit"], ["stand"], ["hit", "stand"]]) expect(StatusDefinitionSchema.safeParse({ ...base, blocksActions }).success).toBe(true);
    for (const blocksActions of [[], ["hit", "hit"], ["draw"], ["PLAYER_STAND"]]) expect(StatusDefinitionSchema.safeParse({ ...base, blocksActions }).success).toBe(false);
    expect(StatusDefinitionSchema.safeParse(base).success).toBe(true);
  });
});
