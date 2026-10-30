import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { cardRank, cardSource, cardSuit, createCard } from "../blackjack/card";
import { RANKS, SUITS, type Rank, type Suit } from "../blackjack/types";
import { abilityWorld, createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { createAbilityRuntime } from "./runtime";
import { AbilityDefinitionSchema, AbilityRuleSchema } from "./schema";
import type { AbilityWorld, Effect } from "./types";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const rankMap: Record<Rank, Rank> = { A: "2", "2": "3", "3": "4", "4": "5", "5": "6", "6": "7", "7": "8", "8": "9", "9": "10", "10": "A", J: "A", Q: "A", K: "A" };
const replacement: Effect = { type: "replace-hand-card-with-derived", target: "owner", card: "last-card", rank: { type: "map-card-rank", card: "last-card", map: rankMap }, suit: { type: "copy-card-suit", card: "last-card" } };
const definition = AbilityDefinitionSchema.parse({ id: "neutral-mapped-draw", name: "Mapped draw", description: "Replace an actual Hit with a derived card of the same suit", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["card-replacement"], activation: { type: "automatic" },
  rules: [{ id: "replace-hit", trigger: "after-card-draw", conditions: [{ type: "actor-is", actor: "owner" }], effects: [replacement] }] });
function fixture(rank: Rank = "10", suit: Suit = SUITS[0]) {
  const card = createCard(suit, rank, "original-card");
  const world: AbilityWorld = { hands: { player: { cards: [createCard("clubs", "3", "public"), card] }, opponent: { cards: [] } }, shoe: { cards: [card], cursor: 1, shuffleIndex: 0 }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, cards: [], skillDraws: 0, statuses: [] };
  const registry = createStandaloneAbilityRegistry([definition], []);
  const ability = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", "neutral-mapper", 1, registry, "ai-skill");
  const rng = new SeededRng("copy-suit");
  return { card, world, ability, registry, runtime: createAbilityRuntime(rng.snapshot(), registry.catalogVersion), rng, event: { trigger: "after-card-draw" as const, sourceEventId: "neutral-hit" } };
}

describe("derived card suit expressions", () => {
  it("copies every original suit and maps all thirteen ranks while leaving the consumed physical card untouched", () => {
    for (const rank of RANKS) for (const suit of SUITS) {
      const context = fixture(rank, suit); const before = JSON.stringify(context.world);
      const result = applyEffects([replacement], context); const card = result.world.hands.player.cards.at(-1)!;
      expect(card.id).not.toBe(context.card.id); expect(cardSource(card)).toBe("derived");
      expect(cardRank(card)).toBe(rankMap[rank]); expect(cardSuit(card)).toBe(suit);
      expect(result.world.shoe).toBe(context.world.shoe); expect(result.world.shoe.cards[0]).toBe(context.card);
      expect(card.tags).toContain("derived"); expect(card.tags).toContain(`generated-by:${definition.id}`);
      expect(result.acquiredCards).toEqual([{ actor: "player", card }]);
      expect(JSON.stringify(context.world)).toBe(before);
      expect(applyEffects([replacement], fixture(rank, suit))).toEqual(result);
    }
  });

  it("resolves public/private selectors before replacement and fails atomically when the source is absent", () => {
    const context = fixture();
    const effect: Effect = { ...replacement, suit: { type: "copy-card-suit", card: "first-public-card" } };
    expect(cardSuit(applyEffects([effect], context).world.hands.player.cards.at(-1)!)).toBe("clubs");
    expect(cardSuit(applyEffects([{ ...replacement, suit: { type: "copy-card-suit", card: "first-private-card" } }], context).world.hands.player.cards.at(-1)!)).toBe("spades");
    const missing = { ...context, world: { ...context.world, hands: { ...context.world.hands, player: { cards: context.world.hands.player.cards.slice(0, 1) } } } };
    const before = JSON.stringify(missing.world);
    expect(() => applyEffects([{ ...replacement, suit: { type: "copy-card-suit", card: "first-private-card" } }], missing)).toThrow("Card suit source");
    expect(JSON.stringify(missing.world)).toBe(before);
    expect(AbilityRuleSchema.safeParse({ id: "bad", trigger: "after-card-draw", effects: [{ ...replacement, suit: { type: "copy-card-suit", card: "unknown" } }] }).success).toBe(false);
  });

  it("replaces only actual Hits before bust checking, preserves the dealt-card log, and survives runtime round trips", () => {
    installAbilityRegistry([...original.definitions, definition], original.statuses, original.catalogVersion);
    const base = createMatch("mapped-draw", { opponentId: "llama", skillDeckIds: [], opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }] });
    const cards = [createCard("hearts", "3", "p-first"), createCard("diamonds", "4", "p-second"), createCard("clubs", "3", "o-first"), createCard("diamonds", "4", "o-second"), createCard("hearts", "K", "hit-original"), ...Array.from({ length: 30 }, (_, i) => createCard("clubs", "2", `remaining-${i}`))];
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined }, opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    const before: MatchState = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }], round: { ...base.round, phase: "turns", currentActor: "opponent", player, opponent, outcome: null } };
    const after = gameReducer(before, { type: "OPPONENT_HIT" }); const derived = after.opponent.hand.cards.at(-1)!;
    expect(cardRank(derived)).toBe("A"); expect(cardSuit(derived)).toBe("hearts"); expect(cardSource(derived)).toBe("derived");
    expect(after.shoe.cursor).toBe(5); expect(after.shoe.cards[4]).toEqual(cards[4]); expect(after.opponent.busted).toBe(false);
    expect(after.history).toContainEqual({ type: "CARD_DEALT", actor: "opponent", card: cards[4], private: true });
    expect(after.history).toContainEqual(expect.objectContaining({ type: "ABILITY_RESULT", result: { type: "derived-card-replaced", actor: "opponent", oldRank: "K", rank: "A", suit: "hearts" } }));
    expect(after.history.filter(event => event.type === "OPPONENT_HIT")).toHaveLength(1);
    expect(validateRuntimeSave(createRuntimeSave(after)).activeMatch!.opponent.hand).toEqual(after.opponent.hand);
    expect(abilityWorld(after).shoe.cards[4].attributes.rank).toBe("K");
    expect(gameReducer(before, { type: "OPPONENT_HIT" })).toEqual(after);
  });
});
