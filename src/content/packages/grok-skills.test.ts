import { afterEach, describe, expect, it } from "vitest";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { ABILITY_REGISTRY, getAbilityDefinition, installAbilityRegistry, instantiateAbility } from "../../core/abilities/registry";
import { addAbilityInstance } from "../../core/abilities/runtime";
import type { AbilityBinding, AbilityDefinition } from "../../core/abilities/types";
import { createCard, createDerivedCard, isDerivedCard } from "../../core/blackjack/card";
import type { Card, Rank } from "../../core/blackjack/types";
import { handValue } from "../../core/blackjack/hand";
import { createMatch, gameReducer, getLegalActions, getRoundHitCounts, normalizeAbilityHands, previewComparisonScores } from "../../core/match/reducer";
import type { MatchState } from "../../core/match/types";
import { INITIAL_PLAYER_SKILL_IDS } from "../../core/skills/definitions";
import { playerSkillsUnlockedForVictory, unlockedPlayerSkillIdsForDefeats } from "../../core/skills/skills";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));

function fixture(bindings: readonly AbilityBinding[], playerRanks: Rank[] = ["10", "8"], opponentRanks: Rank[] = ["10", "9"], opponentId = "grok"): MatchState {
  const base = createMatch("grok-skills", { opponentId, opponentAiSkills: bindings, skillDeckIds: [], grantOpeningSkills: false, openingSkillCards: 0, aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
  const ranks = [...playerRanks, ...opponentRanks, ...Array<Rank>(30).fill("2")];
  const cards = ranks.map((rank, index) => createCard("spades", rank, `grok-fixture-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, playerRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(playerRanks.length, playerRanks.length + opponentRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: playerRanks.length + opponentRanks.length, shuffleIndex: 1 }, history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }], playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}
function hold(state: MatchState, definitionId: string, instanceId = `held-${definitionId}`): MatchState {
  const instance = instantiateAbility({ definitionId, enabled: true, parameters: {} }, "player", instanceId, state.abilities.sequence + 1);
  return { ...state, abilities: addAbilityInstance(state.abilities, instance), playerSkills: { ...state.playerSkills, unlockedDefinitionIds: [...new Set([...state.playerSkills.unlockedDefinitionIds, definitionId])], cards: [...state.playerSkills.cards, { kind: "player-skill", owner: "player", definitionId, level: instance.level ?? 1, instanceId }] } };
}
function play(state: MatchState, definitionId: string): MatchState {
  const card = state.playerSkills.cards.find(card => card.definitionId === definitionId)!;
  return gameReducer(state, { type: "PLAY_ABILITY", instanceId: card.instanceId });
}
function hands(state: MatchState, playerCards: readonly Card[]): MatchState {
  const player = { ...state.player, hand: { cards: playerCards }, bustLimit: undefined };
  return normalizeAbilityHands({ ...state, player, round: { ...state.round, player } });
}
function restore(state: MatchState): MatchState {
  return validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
}

describe("Grok 官方衍生牌技能", () => {
  it("ships S tier, the exact requested names and literature, and a single-use victory reward", async () => {
    expect(getCharacterMetadata("grok")?.tier).toBe("S");
    const character = await loadCharacter("grok");
    expect(character.aiSkills.map(binding => binding.definitionId)).toEqual(["grok-is-it-true", "grok-go-anywhere"]);
    expect(getAbilityDefinition("grok-is-it-true")).toMatchObject({ name: "@grok是真的吗？", profileLore: "到底什么是假新闻？她有自己的看法。", activation: { type: "automatic" } });
    expect(getAbilityDefinition("grok-go-anywhere")).toMatchObject({ name: "想去哪里就去哪里", activation: { type: "automatic" } });
    const reward = getAbilityDefinition("grok-player")!;
    expect(reward).toMatchObject({ name: "@grok", sourceKind: "player-skill", activation: { type: "action", consume: "card", uses: 1 }, unlock: { opponentId: "grok" } });
    expect(reward.displays ?? []).toEqual([]);
    expect(reward.levels ?? []).toEqual([]);
    expect(reward.ttl).toBeUndefined();
    expect(getAbilityDefinition("grok-is-it-true")?.ttl).toBeUndefined();
    expect(getAbilityDefinition("grok-go-anywhere")?.ttl).toBeUndefined();
  });

  it("unlocks @grok only through a real player victory or an existing durable Grok defeat", () => {
    expect(INITIAL_PLAYER_SKILL_IDS).not.toContain("grok-player");
    expect(playerSkillsUnlockedForVictory("grok", "player")).toEqual(["grok-player"]);
    expect(playerSkillsUnlockedForVictory("grok", "opponent")).toEqual([]);
    expect(playerSkillsUnlockedForVictory("grok", "player", true)).toEqual([]);
    expect(unlockedPlayerSkillIdsForDefeats([{ opponentId: "grok", timestamp: "2026-11-13T00:00:00.000Z" }])).toContain("grok-player");
    expect(unlockedPlayerSkillIdsForDefeats([])).not.toContain("grok-player");
  });

  it("makes each newly acquired player derived card worth zero before bust checks", async () => {
    let state = fixture((await loadCharacter("grok")).aiSkills, ["10", "10"]);
    const originalPhysical = state.player.hand.cards;
    state = hold(state, "compound-interest");
    state = play(state, "compound-interest");
    expect(state.player.hand.cards).toHaveLength(3);
    expect(state.player.hand.cards.slice(0, 2)).toEqual(originalPhysical);
    expect(state.player.hand.cards[2]).toMatchObject({ attributes: { source: "derived", rank: "2" } });
    expect(handValue(state.player.hand)).toBe(20);
    expect(state.player.busted).toBe(false);
    expect(previewComparisonScores(state).baseScores.player).toBe(20);
    expect(getRoundHitCounts(state)).toEqual({ player: 0, opponent: 0 });
    expect(restore(state)).toEqual(state);
    state = hold(restore(state), "compound-interest", "second-interest");
    state = play(state, "compound-interest");
    expect(state.player.hand.cards.filter(isDerivedCard).map(card => card.attributes.rank)).toEqual(["2", "3"]);
    expect(handValue(state.player.hand)).toBe(20);
    expect(state.player.busted).toBe(false);
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it("transfers every acquired derived identity to the player in acquisition order without extra Hits", async () => {
    const emitter: AbilityDefinition = { id: "neutral-grok-derived-source", name: "Derived source", description: "Neutral acquisition fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "acquire", trigger: "before-card-draw", conditions: [{ type: "actor-is", actor: "owner" }], effects: ["A", "K"].map(rank => ({ type: "acquire-card" as const, target: "owner" as const, choices: [{ source: "derived" as const, rank: { type: "static" as const, rank: rank as "A" | "K" }, suit: { type: "static" as const, suit: "clubs" as const } }] })) }] };
    installAbilityRegistry([...originalRegistry.definitions, emitter], originalRegistry.statuses, originalRegistry.catalogVersion);
    const bindings = [...(await loadCharacter("grok")).aiSkills, { definitionId: emitter.id, enabled: true, parameters: {} }];
    const state = fixture(bindings);
    const beforeRng = state.rng;
    const after = gameReducer({ ...state, round: { ...state.round, currentActor: "opponent" } }, { type: "OPPONENT_HIT" });
    const derived = after.player.hand.cards.filter(isDerivedCard);
    expect(derived.map(card => card.attributes.rank)).toEqual(["A", "K"]);
    expect(after.opponent.hand.cards.filter(isDerivedCard)).toEqual([]);
    expect(new Set([...after.player.hand.cards, ...after.opponent.hand.cards].map(card => card.id)).size).toBe(after.player.hand.cards.length + after.opponent.hand.cards.length);
    expect(handValue(after.player.hand)).toBe(18);
    expect(handValue(after.opponent.hand)).toBe(21);
    expect(getRoundHitCounts(after)).toEqual({ player: 0, opponent: 1 });
    expect(after.shoe.cursor).toBe(state.shoe.cursor + 1);
    expect(after.rng).toEqual(beforeRng);
    expect(after.history.filter(event => event.type === "ABILITY_TRIGGERED" && event.definitionId === "grok-go-anywhere")).toHaveLength(2);
    expect(after.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(restore(after)).toEqual(after);
  });

  it("does not redirect physical cards obtained by a normal Grok Hit", async () => {
    const state = fixture((await loadCharacter("grok")).aiSkills);
    const after = gameReducer({ ...state, round: { ...state.round, currentActor: "opponent" } }, { type: "OPPONENT_HIT" });
    expect(after.player.hand.cards).toEqual(state.player.hand.cards);
    expect(after.opponent.hand.cards.at(-1)).toEqual(state.shoe.cards[state.shoe.cursor]);
    expect(after.history.some(event => event.type === "ABILITY_TRIGGERED" && event.definitionId === "grok-go-anywhere")).toBe(false);
  });

  it("uses @grok to rescue a derived-card bust, preserves faces, and leaves later acquisitions normal", () => {
    let state = hold(hold(fixture([], ["10", "8"], ["10", "9"], "llama"), "grok-player"), "compound-interest");
    const derived = [createDerivedCard("hearts", "A", "held-derived-ace"), createDerivedCard("clubs", "K", "held-derived-king")];
    state = hands(state, [...state.player.hand.cards, ...derived]);
    expect(state.player.busted).toBe(true);
    const beforeAttributes = state.player.hand.cards.map(card => ({ id: card.id, attributes: card.attributes }));
    const hits = getRoundHitCounts(state);
    const after = play(state, "grok-player");
    expect(after.player.busted).toBe(false);
    expect(handValue(after.player.hand)).toBe(18);
    expect(after.player.hand.cards.map(card => ({ id: card.id, attributes: card.attributes }))).toEqual(beforeAttributes);
    expect(after.playerSkills.cards.map(card => card.definitionId)).toEqual(["compound-interest"]);
    expect(getRoundHitCounts(after)).toEqual(hits);
    expect(restore(after)).toEqual(after);
    const later = play(restore(after), "compound-interest");
    expect(later.player.hand.cards.at(-1)).toMatchObject({ attributes: { source: "derived", rank: "4" } });
    expect(handValue(later.player.hand)).toBe(22);
    expect(later.player.busted).toBe(true);
    expect(later.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(restore(later)).toEqual(later);
  });

  it("does not spend @grok without any held derived card", () => {
    const state = hold(fixture([], ["10", "8"], ["10", "9"], "llama"), "grok-player");
    const action = { type: "PLAY_ABILITY" as const, instanceId: "held-grok-player" };
    expect(getLegalActions(state)).not.toContainEqual(action);
    expect(gameReducer(state, action)).toBe(state);
    expect(restore(state)).toEqual(state);
  });
});
