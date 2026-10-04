import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { loadCharacter } from "../../content/characters/loader";
import { SUITS } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { createMatch, gameReducer, previewComparisonScores } from "../match/reducer";
import { instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { resolveAbilityEvent } from "./engine";
import type { AbilityWorld } from "./types";

function fixture(owner: "player" | "opponent", count: number) {
  const cards = SUITS.slice(0, count).map((suit, i) => createCard(suit, "2", `suit-${i}`));
  const world: AbilityWorld = {
    hands: { player: { cards: cards.slice(0, 2) }, opponent: { cards: cards.slice(2) } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: SUITS.map((suit) => createCard(suit, "K")), cursor: 0, shuffleIndex: 0 },
    cards: [], skillDraws: 0, statuses: []
  };
  const instance = instantiateAbility({ definitionId: "gemini-world-knowledge", enabled: true, parameters: {} }, owner, "world-knowledge", 1, undefined, "ai-skill");
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("world-knowledge").snapshot()), instance);
  return { world, runtime };
}
function compare(input: ReturnType<typeof fixture>) {
  return resolveAbilityEvent({ ...input, event: { trigger: "before-round-resolution", sourceEventId: "comparison", roundOutcome: { reason: "comparison", penaltyTarget: null } }, pendingComparison: { id: "comparison", scores: { player: 18, opponent: 18 } } });
}

describe("world knowledge", () => {
  for (const owner of ["player", "opponent"] as const) {
    it.each([0, 1, 2, 3, 4])(`applies -2 plus distinct table suits to ${owner}: %i suits`, (count) => {
      const input = fixture(owner, count);
      const snapshot = JSON.stringify(input);
      const result = compare(input);
      expect(result.pendingComparison?.scores[owner]).toBe(18 - 2 + count);
      expect(result.pendingComparison?.scores[owner === "player" ? "opponent" : "player"]).toBe(18);
      expect(result.events).toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", owner, definitionId: "gemini-world-knowledge" }));
      expect(result.runtime.rng).toEqual(input.runtime.rng);
      expect(JSON.stringify(input)).toBe(snapshot);
      expect(compare(input)).toEqual(result);
    });
  }
  it("counts shared and repeated suits once, including derived cards, and recalculates after removal", () => {
    const input = fixture("opponent", 1);
    const shared = { ...input, world: { ...input.world, hands: { player: { cards: [createCard("spades", "2"), createCard("spades", "3")] }, opponent: { cards: [createDerivedCard("spades", "4", "shared"), createDerivedCard("clubs", "2", "new-suit")] } } } };
    expect(compare(shared).pendingComparison?.scores.opponent).toBe(18);
    const removed = { ...shared, world: { ...shared.world, hands: { ...shared.world.hands, opponent: { cards: shared.world.hands.opponent.cards.slice(0, 1) } } } };
    expect(compare(removed).pendingComparison?.scores.opponent).toBe(17);
  });
  it("does not modify bust or natural blackjack resolution", () => {
    for (const reason of ["bust", "blackjack"] as const) {
      const result = resolveAbilityEvent({ ...fixture("opponent", 4), event: { trigger: "before-round-resolution", sourceEventId: reason, roundOutcome: { reason, penaltyTarget: "player" } } });
      expect(result.triggered).toEqual([]);
      expect(result.pendingComparison).toBeUndefined();
    }
  });
  it("binds Gemini and previews the live advantage without mutating the match", async () => {
    const character = await loadCharacter("gemini");
    const match = createMatch("gemini-world-knowledge", { opponentId: "gemini", opponentAiSkills: character.aiSkills });
    expect(match.abilities.instances).toContainEqual(expect.objectContaining({ definitionId: "gemini-world-knowledge", owner: "opponent" }));
    const player = { ...match.player, hand: { cards: [createCard("hearts", "8"), createCard("spades", "9")] } };
    const opponent = { ...match.opponent, hand: { cards: [createCard("clubs", "8"), createCard("diamonds", "9")] } };
    const state = { ...match, player, opponent, playerSkills: { ...match.playerSkills, drawOffer: null }, round: { ...match.round, player, opponent, phase: "turns" as const, currentActor: "player" as const, outcome: null } };
    const snapshot = JSON.stringify(state);
    expect(previewComparisonScores(state)).toEqual({ baseScores: { player: 17, opponent: 17 }, scores: { player: 17, opponent: 19 } });
    expect(JSON.stringify(state)).toBe(snapshot);
    const finished = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(finished.round.outcome?.comparisonScores).toEqual({ player: 17, opponent: 19 });
    expect(finished.round.outcome?.winner).toBe("opponent");
  });
});
