import { describe, expect, it } from "vitest";
import { addCardTag, cardPointValue, cardRank, cardSource, cardValue, createCard, createDerivedCard, EXCLUDED_FROM_POINT_TOTAL_TAG, isCardCountedInPointTotal, removeCardTag } from "./card";
import { createHand, handValue, handValueAtLimit, isBlackjack, isBust } from "./hand";
import { drawPhysicalCandidate, fixedCardValue } from "../abilities/card-zone-adapter";
import { buildObservation } from "../ai/observation";
import { decideAiAction } from "../ai/policy";
import { createMatch } from "../match/reducer";

const exclude = <T extends import("./types").Card>(card: T): T => addCardTag(card, EXCLUDED_FROM_POINT_TOTAL_TAG);

describe("card point-total exclusion", () => {
  it("preserves the entity's face, source, tags and identity while contributing zero points", () => {
    const original = createDerivedCard("spades", "K", "derived-king", "neutral-source");
    const zero = exclude(original);
    expect(cardPointValue(zero)).toBe(0);
    expect(fixedCardValue(zero)).toBe(0);
    expect(cardRank(zero)).toBe("K");
    expect(cardSource(zero)).toBe("derived");
    expect(zero.id).toBe(original.id);
    expect(zero.attributes).toBe(original.attributes);
    expect(zero.tags).toEqual([...original.tags, EXCLUDED_FROM_POINT_TOTAL_TAG]);
    expect(isCardCountedInPointTotal(original)).toBe(true);
    expect(cardValue("K")).toBe(10);
    expect(cardPointValue(original)).toBe(10);
    expect(removeCardTag(zero, EXCLUDED_FROM_POINT_TOTAL_TAG)).toEqual(original);
    expect(exclude(zero)).toBe(zero);
  });

  it("never treats an excluded Ace as a soft Ace available for a ten-point reduction", () => {
    const zeroAce = exclude(createDerivedCard("spades", "A", "zero-ace"));
    expect(handValue(createHand([zeroAce, createCard("hearts", "K"), createCard("clubs", "9")]))).toBe(19);
    expect(handValue(createHand([zeroAce, createCard("hearts", "A"), createCard("clubs", "9")]))).toBe(20);
    expect(handValue(createHand([zeroAce, createCard("hearts", "A"), createCard("clubs", "K")]))).toBe(21);
    expect(isBust(createHand([zeroAce, createCard("hearts", "K"), createCard("clubs", "9")]))).toBe(false);
    expect(handValue(createHand([zeroAce, exclude(createDerivedCard("clubs", "A", "other-zero-ace"))]))).toBe(0);
  });

  it("uses the live bust limit for counted Aces while excluded cards remain zero", () => {
    const hand = createHand([createCard("spades", "A"), createCard("hearts", "A"), createCard("clubs", "10"), exclude(createDerivedCard("diamonds", "K", "zero-king"))]);
    expect(handValueAtLimit(hand, 21)).toBe(12);
    expect(handValueAtLimit(hand, 22)).toBe(22);
    expect(handValueAtLimit(hand, 25)).toBe(22);
  });

  it("does not award natural Blackjack for an excluded derived A or face card", () => {
    expect(isBlackjack(createHand([exclude(createDerivedCard("spades", "A", "a")), createCard("hearts", "K")]))).toBe(false);
    expect(isBlackjack(createHand([createCard("hearts", "A"), exclude(createDerivedCard("spades", "K", "k"))]))).toBe(false);
    expect(isBlackjack(createHand([createDerivedCard("spades", "A", "plain-a"), createCard("hearts", "K")]))).toBe(true);
  });

  it("retains zero-point semantics through serialization and transfer without changing the card face", () => {
    const zero = exclude(createDerivedCard("spades", "A", "portable-zero"));
    const restored = JSON.parse(JSON.stringify(zero));
    expect(handValue(createHand([restored, createCard("clubs", "9")]))).toBe(9);
    expect(cardRank(restored)).toBe("A");
    const source = createHand([restored]);
    const target = createHand([createCard("hearts", "10"), ...source.cards]);
    expect(handValue(target)).toBe(10);
    expect(target.cards[1]).toBe(restored);
  });

  it("uses zero-point entities in candidate totals and lowest-value selection", () => {
    const zeroAce = exclude(createCard("spades", "A", "zero-physical-ace"));
    const ordinaryAce = createCard("hearts", "A", "ordinary-ace");
    const shoe = { cards: [ordinaryAce, zeroAce, createCard("clubs", "2", "two")], cursor: 0, shuffleIndex: 0 };
    expect(drawPhysicalCandidate(shoe, createHand(), undefined, "lowest-value")?.card).toBe(zeroAce);
    const held = createHand([createCard("diamonds", "10"), exclude(createDerivedCard("clubs", "K", "held-zero"))]);
    expect(drawPhysicalCandidate(shoe, held, { operator: "exactly", value: 10, evaluationLimit: 21 }, "first")?.card).toBe(zeroAce);
  });

  it("projects the same counted total into the AI observation and decision", () => {
    const base = createMatch("neutral-zero-point-observation", { opponentId: "chatgpt", skillDeckIds: [], opponentAiSkills: [] });
    const opponent = { ...base.opponent, hand: createHand([createCard("hearts", "10", "ten"), createCard("clubs", "5", "five"), exclude(createDerivedCard("spades", "K", "zero"))]), stood: false, busted: false };
    const state = { ...base, opponent, round: { ...base.round, opponent, phase: "turns" as const, currentActor: "opponent" as const } };
    const observation = buildObservation(state, "opponent");
    expect(observation.opponent.value).toBe(15);
    const decision = decideAiAction(observation, { P: 0, A: 0, B: 0, C: 0 }, { match: 0, play: 0 });
    expect(decision).toMatchObject({ handValue: 15, action: "hit" });
  });
});
