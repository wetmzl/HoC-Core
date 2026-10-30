import { addCard, createHand, handValue, handValueAtLimit } from "../blackjack/hand";
import { cardRank, cardSuit, cardValue, createCard, createDerivedCard, createDerivedCardId, isDerivedCard, isPhysicalCard } from "../blackjack/card";
import { RANKS, SUITS, type Card, type Hand, type PhysicalCard, type ShoeState } from "../blackjack/types";
import type { SeededRng } from "../rng/seeded";

/** Consumed physical cards stay in the shoe ledger; derived cards dissipate. */
export function redealInitialHand(shoe: ShoeState): { readonly hand: Hand; readonly shoe: ShoeState } | undefined {
  if (shoe.cards.length - shoe.cursor < 2) return undefined;
  return { hand: createHand(shoe.cards.slice(shoe.cursor, shoe.cursor + 2)), shoe: { ...shoe, cursor: shoe.cursor + 2 } };
}

export interface CardCandidateResult { readonly card: PhysicalCard; readonly index: number; }
export function handCardCount(hand: Hand): number { return hand.cards.length; }
export function handTotal(hand: Hand): number { return handValue(hand); }
export function fixedCardValue(card: Card): number { return cardValue(cardRank(card)); }

/** Returns a held physical card to the remaining pile without duplicating its
 * identity in the shoe's consumed-card ledger or drawing a replacement. */
export function moveHandCardToDrawPile(shoe: ShoeState, hand: Hand, cardIndex: number, position: "top" | "bottom"): { readonly hand: Hand; readonly shoe: ShoeState; readonly card: PhysicalCard } | undefined {
  const card = hand.cards[cardIndex];
  if (!card || !isPhysicalCard(card)) return undefined;
  const ledgerIndex = shoe.cards.findIndex(entry => entry.id === card.id);
  if (ledgerIndex < 0 || ledgerIndex >= shoe.cursor || shoe.cards.filter(entry => entry.id === card.id).length !== 1) return undefined;
  const cards = shoe.cards.filter((_, index) => index !== ledgerIndex);
  const cursor = shoe.cursor - 1;
  cards.splice(position === "top" ? cursor : cards.length, 0, card);
  return { hand: createHand(hand.cards.filter((_, index) => index !== cardIndex)), shoe: { ...shoe, cards, cursor }, card };
}

export function swapLastHandCardWithDrawPileTop(shoe: ShoeState, hand: Hand): { readonly hand: Hand; readonly shoe: ShoeState } | undefined {
  if (hand.cards.length === 0 || shoe.cursor >= shoe.cards.length) return undefined;
  const outgoing = hand.cards.at(-1)!;
  const top = shoe.cards[shoe.cursor]!;
  const cards = [...hand.cards.slice(0, -1), top];
  if (isDerivedCard(outgoing)) return { hand: createHand(cards), shoe: { ...shoe, cursor: shoe.cursor + 1 } };
  const outgoingIndex = shoe.cards.findIndex((card, index) => index < shoe.cursor && card.id === outgoing.id);
  if (outgoingIndex < 0) return undefined;
  const shoeCards = [...shoe.cards];
  shoeCards[outgoingIndex] = top;
  shoeCards[shoe.cursor] = outgoing;
  return { hand: createHand(cards), shoe: { ...shoe, cards: shoeCards } };
}

/** Canonical unordered rank partitions keep sampling stable for a given policy. */
export function rankPartitions(total: number, count: number): readonly (readonly import("../blackjack/types").Rank[])[] {
  if (!Number.isInteger(count) || count < 1 || count > 6 || !Number.isFinite(total)) return [];
  const result: import("../blackjack/types").Rank[][] = [];
  const visit = (start: number, remaining: number, ranks: import("../blackjack/types").Rank[]): void => {
    if (ranks.length === count) { if (remaining === 0) result.push(ranks); return; }
    for (let i = start; i < RANKS.length; i++) {
      const value = cardValue(RANKS[i]!);
      if (value <= remaining) visit(i, remaining - value, [...ranks, RANKS[i]!]);
    }
  };
  visit(0, total, []);
  return result;
}
export function transformHandCard(hand: Hand, cardIndex: number, count: number, total: number, suits: import("./types").CardTransform["suits"], rng: SeededRng, generatedBy?: string): { readonly hand: Hand; readonly cards: readonly Card[] } | undefined {
  const source = hand.cards[cardIndex];
  if (!source) return undefined;
  const partitions = rankPartitions(total, count);
  if (!partitions.length) return undefined;
  const ranks = partitions[rng.nextInt(partitions.length)]!;
  const firstSuit = suits === "source-suit" ? cardSuit(source) : SUITS[rng.nextInt(SUITS.length)]!;
  const sameColor = SUITS.filter(suit => (suit === "hearts" || suit === "diamonds") === (firstSuit === "hearts" || firstSuit === "diamonds"));
  const cards = ranks.map((rank, index) => {
    const suit = index === 0 || suits === "same-suit" || suits === "source-suit" ? firstSuit
      : suits === "same-color" ? sameColor[rng.nextInt(sameColor.length)]! : SUITS[rng.nextInt(SUITS.length)]!;
    return createDerivedCard(suit, rank, createDerivedCardId(rng), generatedBy);
  });
  return { hand: createHand([...hand.cards.slice(0, cardIndex), ...cards, ...hand.cards.slice(cardIndex + 1)]), cards };
}

export function findCardCandidates(shoe: ShoeState, hand: Hand, target: "at-most" | "exactly", total: number): readonly CardCandidateResult[] {
  return shoe.cards.slice(shoe.cursor).map((card, offset) => ({ card, index: shoe.cursor + offset })).filter(({ card }) => {
    const value = handValue(addCard({ cards: hand.cards.slice(0, -1) }, card));
    return target === "at-most" ? value <= total : value === total;
  });
}

export function findDrawCandidates(shoe: ShoeState, hand: Hand, target: "at-most" | "exactly", total: number): readonly CardCandidateResult[] {
  return shoe.cards.slice(shoe.cursor).map((card, offset) => ({ card, index: shoe.cursor + offset })).filter(({ card }) => {
    const value = handValue(addCard(hand, card));
    return target === "at-most" ? value <= total : value === total;
  });
}

/**
 * Atomically replaces the last hand card with one remaining physical card.
 * A physical outgoing card returns to the shoe; a derived outgoing card
 * dissipates and the selected shoe card is consumed instead.
 */
export function replaceLastHandCard(shoe: ShoeState, hand: Hand, rng: SeededRng, target: "at-most" | "exactly", total: number): { readonly hand: Hand; readonly shoe: ShoeState } | undefined {
  const candidates = findCardCandidates(shoe, hand, target, total);
  if (candidates.length === 0 || hand.cards.length === 0) return undefined;
  const selected = candidates[rng.nextInt(candidates.length)]!;
  const handCards = [...hand.cards];
  const shoeCards = [...shoe.cards];
  const outgoing = handCards[handCards.length - 1]!;
  handCards[handCards.length - 1] = selected.card;
  if (!isDerivedCard(outgoing)) {
    shoeCards[selected.index] = outgoing;
    return { hand: createHand(handCards), shoe: { ...shoe, cards: shoeCards } };
  }
  [shoeCards[shoe.cursor], shoeCards[selected.index]] = [shoeCards[selected.index]!, shoeCards[shoe.cursor]!];
  return { hand: createHand(handCards), shoe: { ...shoe, cards: shoeCards, cursor: shoe.cursor + 1 } };
}

export interface ExactDrawResult { readonly card: Card; readonly shoe: ShoeState; readonly derived: boolean; }

/** Resolve a guaranteed total without ever asking the RNG for an empty range. */
export function drawExactResultingTotal(shoe: ShoeState, hand: Hand, rng: SeededRng, total: number, generatedBy?: string): ExactDrawResult | undefined {
  const candidates = findDrawCandidates(shoe, hand, "exactly", total);
  if (candidates.length > 0) {
    const selected = candidates[rng.nextInt(candidates.length)]!;
    const cards = [...shoe.cards];
    [cards[shoe.cursor], cards[selected.index]] = [cards[selected.index]!, cards[shoe.cursor]!];
    return { card: cards[shoe.cursor]!, shoe: { ...shoe, cards, cursor: shoe.cursor + 1 }, derived: false };
  }
  const ranks = RANKS.filter((rank) => handValue(addCard(hand, createCard("spades", rank))) === total);
  if (ranks.length === 0) return undefined;
  const rank = ranks[rng.nextInt(ranks.length)]!;
  const suit = SUITS[rng.nextInt(SUITS.length)]!;
  return { card: createDerivedCard(suit, rank, createDerivedCardId(rng), generatedBy), shoe, derived: true };
}

/** Select one physical entity without changing identity or sampling an empty set. */
export function drawPhysicalCandidate(shoe: ShoeState, hand: Hand, candidate: { readonly operator: "at-most" | "exactly"; readonly value: number; readonly evaluationLimit: number } | undefined, pick: "first" | "lowest-value" | "uniform-ability-rng", rng?: SeededRng): { readonly card: PhysicalCard; readonly shoe: ShoeState } | undefined {
  const candidates = shoe.cards.slice(shoe.cursor).map((card, offset) => ({ card, index: shoe.cursor + offset })).filter(({ card }) => {
    if (!candidate) return true;
    const total = handValueAtLimit(addCard(hand, card), candidate.evaluationLimit);
    return candidate.operator === "at-most" ? total <= candidate.value : total === candidate.value;
  });
  if (!candidates.length) return undefined;
  if (pick === "uniform-ability-rng" && !rng) throw new Error("Random selection requires its ability RNG");
  const minimum = (card: Card) => cardRank(card) === "A" ? 1 : fixedCardValue(card);
  const selected = pick === "uniform-ability-rng" ? candidates[rng!.nextInt(candidates.length)]!
    : pick === "lowest-value" ? candidates.reduce((a, b) => minimum(b.card) < minimum(a.card) ? b : a) : candidates[0]!;
  const cards = [...shoe.cards];
  [cards[shoe.cursor], cards[selected.index]] = [cards[selected.index]!, cards[shoe.cursor]!];
  return { card: selected.card, shoe: { ...shoe, cards, cursor: shoe.cursor + 1 } };
}
