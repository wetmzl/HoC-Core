import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import type { Card } from "../blackjack/types";
import { findHandTransferCandidates } from "./hand-transfer-selection";
import type { AbilityWorld } from "./types";

function world(player: readonly Card[], opponent: readonly Card[]): AbilityWorld {
  return {
    hands: { player: { cards: player }, opponent: { cards: opponent } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 },
    cards: [], statuses: [], skillDraws: 0
  };
}

describe("projected hand transfer candidates", () => {
  it("keeps source order and transfers a single original card without mutating the input", () => {
    const source = [createCard("hearts", "2", "first"), createCard("clubs", "5", "skip"), createCard("spades", "2", "second")];
    const initial = world(source, [createCard("diamonds", "10", "public"), createCard("clubs", "9", "private")]);
    const candidates = findHandTransferCandidates(initial, "player", "opponent", () => 21);
    expect(candidates.map(entry => entry.card.id)).toEqual([source[0]!.id, source[2]!.id]);
    expect(candidates[0]!.world.hands.player.cards).toEqual(source.slice(1));
    expect(candidates[0]!.world.hands.opponent.cards).toEqual([...initial.hands.opponent.cards, source[0]]);
    expect(candidates[0]!.card).toBe(source[0]);
    expect(candidates[0]!.world.shoe).toBe(initial.shoe);
    expect(initial.hands.player.cards).toEqual(source);
    expect(initial.hands.opponent.cards).toHaveLength(2);
  });

  it("reevaluates every Ace under the receiving actor's effective limit", () => {
    const ace = createCard("hearts", "A", "transfer");
    const initial = world([ace, createCard("spades", "K", "too-large")], [createCard("clubs", "A", "held-ace"), createCard("diamonds", "9", "held-nine")]);
    expect(findHandTransferCandidates(initial, "player", "opponent", () => 21).map(entry => entry.card)).toEqual([ace]);
    expect(findHandTransferCandidates(initial, "player", "opponent", () => 22)).toEqual([]);
    const two = createCard("hearts", "2", "two");
    const raised = { ...initial, hands: { ...initial.hands, player: { cards: [two] } } };
    expect(findHandTransferCandidates(raised, "player", "opponent", () => 22)[0]?.card).toBe(two);
  });

  it("uses the recipient's hand size after appending the card", () => {
    const two = createCard("hearts", "2", "two"), ace = createCard("hearts", "A", "ace");
    const initial = world([ace, two], [createCard("clubs", "10", "ten"), createCard("spades", "10", "other-ten")]);
    const candidates = findHandTransferCandidates(initial, "player", "opponent", (actor, projected) => 19 + projected.hands[actor].cards.length);
    expect(candidates.map(entry => entry.card)).toEqual([two]);
  });

  it("removes the source card before evaluating a limit that depends on the rival hand", () => {
    const three = createCard("hearts", "3", "three"), four = createCard("hearts", "4", "four");
    const initial = world([four, three, createCard("clubs", "8", "other")], [createCard("spades", "10", "ten"), createCard("diamonds", "10", "other-ten")]);
    const candidates = findHandTransferCandidates(initial, "player", "opponent", (_actor, projected) => 21 + projected.hands.player.cards.length);
    expect(candidates.map(entry => entry.card)).toEqual([three]);
  });

  it("supports derived cards and either transfer direction", () => {
    const derived = createDerivedCard("hearts", "A", "derived-ace");
    const initial = world([createCard("clubs", "10", "ten"), createCard("diamonds", "10", "other-ten")], [derived]);
    const candidate = findHandTransferCandidates(initial, "opponent", "player", () => 21)[0]!;
    expect(candidate.card).toBe(derived);
    expect(candidate.world.hands.opponent.cards).toEqual([]);
    expect(candidate.world.hands.player.cards.at(-1)).toBe(derived);
  });

  it("rejects self transfers, absent candidates, and cards already in the receiver's hand", () => {
    const card = createCard("hearts", "2", "shared");
    const initial = world([card], [card, createCard("clubs", "9", "nine"), createCard("spades", "8", "eight")]);
    expect(findHandTransferCandidates(initial, "player", "player", () => 21)).toEqual([]);
    expect(findHandTransferCandidates(initial, "player", "opponent", () => 21)).toEqual([]);
    expect(findHandTransferCandidates(world([], []), "player", "opponent", () => 21)).toEqual([]);
  });
});
