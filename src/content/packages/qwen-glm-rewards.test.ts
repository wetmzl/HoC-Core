import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, getAbilityDefinition, installAbilityRegistry } from "../../core/abilities/registry";
import type { PlayerSkillAbilityDefinition } from "../../core/abilities/types";
import { createCard } from "../../core/blackjack/card";
import { handValue } from "../../core/blackjack/hand";
import type { Rank } from "../../core/blackjack/types";
import { createMatch, gameReducer, getRoundHitCounts, previewComparisonScores } from "../../core/match/reducer";
import type { MatchState } from "../../core/match/types";
import { INITIAL_PLAYER_SKILL_IDS } from "../../core/skills/definitions";
import { playerSkillsUnlockedForVictory, unlockedPlayerSkillIdsForDefeats } from "../../core/skills/skills";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const qwenId = "qwen-takeaway-player", glmId = "glm-aliyun-oss-player", bonusId = "qwen-takeaway-player-bonus";

function hands(state: MatchState, playerRanks: readonly Rank[], opponentRanks: readonly Rank[], remainingRanks: readonly Rank[] = Array(40).fill("2")): MatchState {
  const cards = [...playerRanks, ...opponentRanks, ...remainingRanks].map((rank, index) => createCard("clubs", rank, `reward-${state.roundIndex}-${index}`));
  const player = { ...state.player, hand: { cards: cards.slice(0, playerRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...state.opponent, hand: { cards: cards.slice(playerRanks.length, playerRanks.length + opponentRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  return { ...state, player, opponent, shoe: { cards, cursor: playerRanks.length + opponentRanks.length, shuffleIndex: 1 },
    round: { ...state.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}

function fixture(playerRanks: readonly Rank[] = ["2", "2"], opponentRanks: readonly Rank[] = ["2", "2"], remainingRanks?: readonly Rank[]): MatchState {
  const base = createMatch("qwen-glm-player-rewards", { opponentId: "llama", opponentAiSkills: [], skillDeckIds: [], openingSkillCards: 0, grantOpeningSkills: false,
    unlockedPlayerSkillIds: [...INITIAL_PLAYER_SKILL_IDS, qwenId, glmId] });
  return hands({ ...base, history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }] }, playerRanks, opponentRanks, remainingRanks);
}

function gain(state: MatchState, definitionId: string): MatchState {
  return gameReducer({ ...state, playerSkills: { ...state.playerSkills, drawCount: 1, drawOffer: { id: `reward-gain-${state.abilities.sequence}`, refreshesRemaining: 0, candidateDefinitionIds: [definitionId] } } }, { type: "SELECT_SKILL_DRAW", definitionId });
}

function play(state: MatchState, id = qwenId): MatchState {
  const card = state.playerSkills.cards.find(entry => entry.definitionId === id)!;
  expect(card).toBeDefined();
  return gameReducer(state, { type: "PLAY_ABILITY", instanceId: card.instanceId });
}

function restore(state: MatchState): MatchState {
  return validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
}

function nextSymmetricRound(state: MatchState): MatchState {
  let next = gameReducer(state, { type: "PLAYER_STAND" });
  next = gameReducer(next, { type: "OPPONENT_STAND" });
  expect(next.round.outcome?.reason).toBe("push");
  expect(next.round.phase).toBe("round-reveal");
  return gameReducer(next, { type: "ACK_ROUND_RESULT" });
}

describe("Qwen and GLM defeat rewards", () => {
  it.each([["qwen", qwenId, "外卖和奶茶"], ["glm", glmId, "阿里云OSS"]])("unlocks %s's reward only for a real victory, including durable defeat history", (character, skill, name) => {
    expect(getAbilityDefinition(skill)?.name).toBe(name);
    expect(getAbilityDefinition(skill)?.displays ?? []).toEqual([]);
    expect(INITIAL_PLAYER_SKILL_IDS).not.toContain(skill);
    expect(playerSkillsUnlockedForVictory(character, "player")).toEqual([skill]);
    expect(playerSkillsUnlockedForVictory(character, "opponent")).toEqual([]);
    expect(playerSkillsUnlockedForVictory(character, "player", true)).toEqual([]);
    expect(unlockedPlayerSkillIdsForDefeats([{ opponentId: character, timestamp: "2026-11-13T00:00:00.000Z" }])).toContain(skill);
  });

  it("grants Qwen's +2 even when there is no other usable active skill", () => {
    const state = gain(fixture(), qwenId);
    const after = play(state);
    expect(after.playerSkills.cards).toEqual([]);
    expect(after.abilities.statuses).toContainEqual(expect.objectContaining({ statusDefinitionId: bonusId, owner: "player", stacks: 2, duration: "round" }));
    const scores = previewComparisonScores(after);
    expect(scores.scores.player - scores.baseScores.player).toBe(2);
    expect(after.history.filter(event => event.type === "ABILITY_PLAYED").map(event => event.definitionId)).toEqual([qwenId]);
    expect(getRoundHitCounts(after)).toEqual({ player: 0, opponent: 0 });
    expect(restore(after)).toEqual(after);
  });

  it("keeps an unavailable other card while still awarding +2", () => {
    let state = gain(gain(fixture(), qwenId), "prepaid-premium");
    state = { ...state, roulette: { ...state.roulette, player: { capacity: 6, bullets: 6 } } };
    const other = state.playerSkills.cards.find(card => card.definitionId === "prepaid-premium");
    const after = play(state);
    expect(after.playerSkills.cards).toEqual([other]);
    expect(after.abilities.statuses.find(status => status.statusDefinitionId === bonusId)?.stacks).toBe(2);
  });

  it("applies +2 before checking whether the next held active can be used", () => {
    const follower: PlayerSkillAbilityDefinition = { id: "neutral-after-two-points", name: "Neutral follower", description: "Requires the earlier bonus", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["active"],
      drop: { enabled: true, baseWeight: 1 }, stackable: false,
      activation: { type: "action", windows: ["owner-turn"], consume: "card", availability: [{ type: "scalar-compare", left: { type: "status-stacks", target: "owner", statusDefinitionId: bonusId }, operator: "gte", right: 2 }] },
      rules: [{ id: "apply", trigger: "on-ability-played", effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] }] };
    installAbilityRegistry([...original.definitions, follower], original.statuses, original.catalogVersion);
    const state = gain(gain(fixture(), qwenId), follower.id);
    const after = play(state);
    expect(after.playerSkills.cards).toEqual([]);
    expect(after.roulette.player.bullets).toBe(1);
    expect(after.abilities.statuses.find(status => status.statusDefinitionId === bonusId)?.stacks).toBe(2);
    expect(after.history.filter(event => event.type === "ABILITY_PLAYED").map(event => event.definitionId)).toEqual([qwenId, follower.id]);
    expect(restore(after)).toEqual(after);
  });

  it("can chain two actual copies of Qwen's reward once each, accumulating +4", () => {
    const state = gain(gain(fixture(), qwenId), qwenId);
    const ids = state.playerSkills.cards.map(card => card.instanceId);
    expect(new Set(ids).size).toBe(2);
    const after = play(state);
    expect(after.playerSkills.cards).toEqual([]);
    expect(after.history.filter(event => event.type === "ABILITY_PLAYED").map(event => event.instanceId).sort()).toEqual([...ids].sort());
    expect(after.abilities.statuses.find(status => status.statusDefinitionId === bonusId)?.stacks).toBe(4);
    const score = previewComparisonScores(after);
    expect(score.scores.player - score.baseScores.player).toBe(4);
    expect(restore(after)).toEqual(after);
  });

  it("expires Qwen's bonus after the current round", () => {
    const after = play(gain(fixture(), qwenId));
    const advanced = gameReducer({ ...after, round: { ...after.round, phase: "round-reveal", currentActor: null, outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
    expect(advanced.abilities.statuses.some(status => status.statusDefinitionId === bonusId)).toBe(false);
    expect(previewComparisonScores(advanced).scores.player - previewComparisonScores(advanced).baseScores.player).toBe(0);
  });

  it("checks GLM's passive immediately on acquisition and steals the first matching original card", () => {
    const state = fixture(["10", "9"], ["2", "5", "2"]);
    const first = state.opponent.hand.cards[0]!;
    const after = gain(state, glmId);
    expect(after.player.hand.cards.at(-1)).toEqual(first);
    expect(after.opponent.hand.cards.map(card => card.id)).toEqual(state.opponent.hand.cards.slice(1).map(card => card.id));
    expect(handValue(after.player.hand)).toBe(21);
    expect(after.shoe.cursor).toBe(state.shoe.cursor);
    expect(after.playerSkills.cards.map(card => card.definitionId)).toEqual([glmId]);
    expect(after.abilities.instances.find(instance => instance.definitionId === glmId)?.ttl).toEqual({ type: "rounds", remaining: 2 });
    expect(getRoundHitCounts(after)).toEqual({ player: 0, opponent: 0 });
    expect(restore(after)).toEqual(after);
  });

  it.each(["player", "opponent"] as const)("rechecks GLM's passive after the %s hand changes", actor => {
    const state = actor === "player" ? gain(fixture(["10", "5"], ["2", "8"], ["4", ...Array(30).fill("2")]), glmId)
      : gain(fixture(["10", "6"], ["2", "3"], ["5", ...Array(30).fill("2")]), glmId);
    expect(handValue(state.player.hand)).toBe(actor === "player" ? 15 : 16);
    const after = gameReducer({ ...state, round: { ...state.round, currentActor: actor } }, { type: actor === "player" ? "PLAYER_HIT" : "OPPONENT_HIT" });
    expect(handValue(after.player.hand)).toBe(21);
    expect(after.shoe.cursor).toBe(state.shoe.cursor + 1);
    expect(getRoundHitCounts(after)).toEqual({ player: actor === "player" ? 1 : 0, opponent: actor === "opponent" ? 1 : 0 });
    expect(after.playerSkills.cards.map(card => card.definitionId)).toEqual([glmId]);
    expect(restore(after)).toEqual(after);
  });

  it("keeps GLM's passive through its acquisition round and the next, then removes it before the third", () => {
    let state = gain(fixture(), glmId);
    expect(state.abilities.instances.find(instance => instance.definitionId === glmId)?.ttl?.remaining).toBe(2);
    state = restore(nextSymmetricRound(state));
    expect(state.roundIndex).toBe(1);
    expect(state.abilities.instances.find(instance => instance.definitionId === glmId)?.ttl?.remaining).toBe(1);
    expect(state.playerSkills.cards.map(card => card.definitionId)).toEqual([glmId]);
    state = restore(nextSymmetricRound(state));
    expect(state.roundIndex).toBe(2);
    expect(state.playerSkills.cards).toEqual([]);
    expect(state.abilities.instances.some(instance => instance.definitionId === glmId)).toBe(false);
    state = hands(state, ["10", "7"], ["2", "3"]);
    const before = state.player.hand.cards;
    const after = gameReducer(state, { type: "PLAYER_HIT" });
    expect(after.player.hand.cards.slice(0, before.length)).toEqual(before);
    expect(after.player.hand.cards).toHaveLength(before.length + 1);
    expect(handValue(after.player.hand)).toBe(19);
    expect(after.opponent.hand).toEqual(state.opponent.hand);
    expect(after.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });
});
