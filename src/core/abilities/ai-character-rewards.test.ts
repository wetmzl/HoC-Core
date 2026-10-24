import { describe, expect, it } from "vitest";
import { loadCharacter } from "../../content/characters/loader";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { abilityTriggerNotice } from "../../presentation/ability-notices";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Card } from "../blackjack/types";
import { abilityWorld, createMatch, gameReducer, getLegalActions, getRoundHitCounts, normalizeAbilityHands, previewComparisonScores } from "../match/reducer";
import type { MatchState } from "../match/types";
import { resolveSkillDeck } from "../skills/deck";
import { INITIAL_PLAYER_SKILL_IDS } from "../skills/definitions";
import { playerSkillsUnlockedForVictory, unlockedPlayerSkillIdsForDefeats } from "../skills/skills";
import { canPlayAbility, playAbility } from "./engine";

const rewards = { chatgpt: "chatgpt-reset-player", claude: "claude-account-ban", gemini: "gemini-vast-world", deepseek: "deepseek-stealing-food-player" };
function fixture(ids: string[] = Object.values(rewards)): MatchState {
  const base = createMatch("ai-rewards", { opponentId: "llama", skillDeckIds: [], unlockedPlayerSkillIds: [...INITIAL_PLAYER_SKILL_IDS, ...Object.values(rewards)] });
  const cards = [createCard("spades", "8", "p-public"), createCard("hearts", "9", "p-private"), createCard("clubs", "8", "o-public"), createCard("diamonds", "9", "o-private"), ...Array.from({ length: 40 }, (_, i) => createCard("spades", "2", `remaining-${i}`))];
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
  const state: MatchState = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
  // Each grant is a separate action so duplicate active cards exercise real stacking.
  return ids.reduce((current, id) => gameReducer({ ...current, playerSkills: { ...current.playerSkills, drawCount: 1, drawOffer: { id: `fixture-${id}`, refreshesRemaining: 0, candidateDefinitionIds: [id] } } }, { type: "SELECT_SKILL_DRAW", definitionId: id }), state);
}
function play(state: MatchState, id: string): MatchState {
  const card = state.playerSkills.cards.find(card => card.definitionId === id)!;
  return gameReducer(state, { type: "PLAY_ABILITY", instanceId: card.instanceId });
}
function hands(state: MatchState, playerCards: readonly Card[], opponentCards = state.opponent.hand.cards): MatchState {
  const player = { ...state.player, hand: { cards: playerCards }, bustLimit: undefined };
  const opponent = { ...state.opponent, hand: { cards: opponentCards }, bustLimit: undefined };
  return normalizeAbilityHands({ ...state, player, opponent, round: { ...state.round, player, opponent } });
}
function nextRound(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}

describe("AI character victory rewards", () => {
  it.each(Object.entries(rewards))("unlocks %s from both a victory and existing durable defeats", (character, skill) => {
    expect(INITIAL_PLAYER_SKILL_IDS).not.toContain(skill);
    expect(playerSkillsUnlockedForVictory(character, "player")).toEqual([skill]);
    expect(playerSkillsUnlockedForVictory(character, "opponent")).toEqual([]);
    expect(playerSkillsUnlockedForVictory(character, "player", true)).toEqual([]);
    const unlocked = unlockedPlayerSkillIdsForDefeats([{ opponentId: character, timestamp: "2026-10-15T00:00:00.000Z" }]);
    expect(unlocked).toContain(skill);
    expect(resolveSkillDeck({ carried: [...INITIAL_PLAYER_SKILL_IDS], reserve: [] }, unlocked).reserve).toContain(skill);
  });
  it("keeps Llama without a victory reward", () => expect(playerSkillsUnlockedForVictory("llama", "player")).toEqual([]));

  it.each([false, true])("RESET redeals all cards atomically, including a busted hand: %s", (busted) => {
    let state = fixture([rewards.chatgpt]);
    state = hands(state, busted ? [createCard("spades", "K", "old-1"), createCard("hearts", "K", "old-2"), createDerivedCard("clubs", "5", "old-derived")] : [...state.player.hand.cards]);
    const before = JSON.stringify(state);
    const oldIds = state.player.hand.cards.map(c => c.id);
    const after = play(state, rewards.chatgpt);
    expect(after.player.hand.cards).toEqual(state.shoe.cards.slice(4, 6));
    expect(after.player.busted).toBe(false);
    expect(after.shoe.cursor).toBe(6);
    expect(after.opponent).toEqual(state.opponent);
    expect(after.roundIndex).toBe(state.roundIndex);
    expect(after.round.currentActor).toBe("player");
    expect(getRoundHitCounts(after)).toEqual(getRoundHitCounts(state));
    expect(after.playerSkills.cards).toHaveLength(0);
    expect(after.history).toContainEqual({ type: "HAND_REDEALT", actor: "player", discardedCardIds: oldIds });
    expect(after.history.filter(e => e.type === "CARD_DEALT").map(e => "private" in e && e.private)).toEqual([false, true]);
    expect(JSON.stringify(state)).toBe(before);
    expect(validateRuntimeSave(createRuntimeSave(after)).activeMatch.player.hand).toEqual(after.player.hand);
  });
  it.each([0, 1])("RESET is unavailable with %i cards remaining, without spending the skill", (count) => {
    const base = fixture([rewards.chatgpt]);
    const state = { ...base, shoe: { ...base.shoe, cards: base.shoe.cards.slice(0, base.shoe.cursor + count) } };
    const action = { type: "PLAY_ABILITY" as const, instanceId: state.playerSkills.cards[0].instanceId };
    expect(getLegalActions(state)).not.toContainEqual(action);
    expect(gameReducer(state, action)).toBe(state);
  });

  it("forces Claude to stand immediately without triggering the safety constitution", async () => {
    const state = fixture([rewards.claude]);
    const character = await loadCharacter("claude");
    const base = createMatch("claude-reward", { opponentId: "claude", opponentAiSkills: character.aiSkills });
    const withClaude = { ...state, opponentId: "claude", abilities: { ...state.abilities, instances: [...base.abilities.instances, ...state.abilities.instances], sequence: base.abilities.sequence + state.abilities.sequence } };
    const after = play(withClaude, rewards.claude);
    expect(after.opponent.stood).toBe(true);
    expect(after.player.stood).toBe(false);
    expect(after.round.currentActor).toBe("player");
    expect(after.history.filter(e => e.type === "OPPONENT_STOOD")).toHaveLength(1);
    expect(after.abilities.statuses.some(s => s.statusDefinitionId === "claude-safety-no-hit")).toBe(false);
    expect(getLegalActions(after)).toContainEqual({ type: "PLAYER_HIT" });
    const hit = gameReducer(after, { type: "PLAYER_HIT" });
    expect(hit.player.hand.cards).toHaveLength(3);
    expect(hit.round.currentActor).toBe("player");
    expect(gameReducer(hit, { type: "OPPONENT_HIT" })).toBe(hit);
    expect(gameReducer(after, { type: "PLAYER_STAND" }).round.phase).toBe("round-reveal");
    expect(validateRuntimeSave(createRuntimeSave(after)).activeMatch.opponent.stood).toBe(true);
    expect(abilityTriggerNotice(after.history, "Claude", after).some(n => n.text.includes("封禁账号"))).toBe(true);
  });
  it("does not spend a second account-ban card once the target has stood", () => {
    const after = play(fixture([rewards.claude, rewards.claude]), rewards.claude);
    expect(play(after, rewards.claude)).toBe(after);
    expect(after.playerSkills.cards).toHaveLength(1);
  });
  it("rejects immediate standing without match turn context and preserves inputs", () => {
    const state = fixture([rewards.claude]);
    const { stood: _stood, ...world } = abilityWorld(state);
    const input = { world, runtime: state.abilities, instanceId: state.playerSkills.cards[0].instanceId, owner: "player" as const, window: "owner-turn" as const };
    const snapshot = JSON.stringify(input);
    expect(canPlayAbility(input)).toBe(false);
    expect(() => playAbility(input)).toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("requires all four current table suits, including private and derived cards", () => {
    const state = fixture([rewards.gemini]);
    const missing = hands(state, state.player.hand.cards, [state.opponent.hand.cards[0], createCard("clubs", "9", "duplicate-suit")]);
    expect(play(missing, rewards.gemini)).toBe(missing);
    const complete = hands(missing, missing.player.hand.cards, [...missing.opponent.hand.cards, createDerivedCard("diamonds", "2", "fourth-suit")]);
    expect(play(complete, rewards.gemini).playerSkills.cards).toHaveLength(0);
    expect(previewComparisonScores(play(complete, rewards.gemini)).scores.player).toBe(19);
  });
  it("keeps an activated world bonus when suits disappear and stacks multiple cards", () => {
    const state = fixture([rewards.gemini, rewards.gemini, rewards.deepseek, rewards.deepseek]);
    let after = play(play(play(play(state, rewards.gemini), rewards.gemini), rewards.deepseek), rewards.deepseek);
    expect(previewComparisonScores(after)).toEqual({ baseScores: { player: 17, opponent: 17 }, scores: { player: 21, opponent: 15 } });
    after = hands(after, [after.player.hand.cards[0]], [after.opponent.hand.cards[0]]);
    expect(previewComparisonScores(after).scores).toEqual({ player: 12, opponent: 6 });
    expect(abilityTriggerNotice(after.history, "Llama", after).some(n => n.text.includes("玩家本回合点数优势 +2"))).toBe(true);
    expect(abilityTriggerNotice(after.history, "Llama", after).some(n => n.text.includes("对手本回合点数优势 −1"))).toBe(true);
    const restored = validateRuntimeSave(createRuntimeSave(after)).activeMatch;
    expect(previewComparisonScores(restored)).toEqual(previewComparisonScores(after));
    const finished = gameReducer(gameReducer(after, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(finished.round.outcome?.comparisonScores).toEqual({ player: 12, opponent: 6 });
    const next = nextRound(finished);
    expect(next.abilities.statuses.some(s => s.statusDefinitionId.includes("vast-world") || s.statusDefinitionId.includes("stealing-food-player"))).toBe(false);
  });
  it("point advantage never changes a bust or its resolution", () => {
    let state = play(play(fixture([rewards.gemini, rewards.deepseek]), rewards.gemini), rewards.deepseek);
    state = hands(state, state.player.hand.cards, [createCard("clubs", "K", "bust-1"), createCard("diamonds", "K", "bust-2"), createCard("spades", "2", "bust-3")]);
    expect(state.opponent.busted).toBe(true);
    expect(previewComparisonScores(state).baseScores.opponent).toBe(22);
    const finished = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(finished.round.outcome).toMatchObject({ reason: "bust", winner: "player" });
  });
});
