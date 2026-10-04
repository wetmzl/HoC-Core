import { cardRank, cardValue } from "./card";
import type { Card, Hand } from "./types";

export function createHand(cards: readonly Card[] = []): Hand {
  return { cards: [...cards] };
}

export function addCard(hand: Hand, card: Card): Hand {
  return { cards: [...hand.cards, card] };
}

/** Returns the highest total legal under the supplied bust limit. */
export function handValueAtLimit(hand: Hand, bustLimit: number): number {
  let total = 0;
  let aces = 0;
  for (const card of hand.cards) {
    total += cardValue(cardRank(card));
    if (cardRank(card) === "A") aces += 1;
  }
  while (total > bustLimit && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/** Returns the highest legal total under the standard Blackjack limit. */
export function handValue(hand: Hand): number {
  return handValueAtLimit(hand, 21);
}

export function isBlackjack(hand: Hand): boolean {
  return hand.cards.length === 2 && handValue(hand) === 21;
}

export function isBust(hand: Hand): boolean {
  return handValue(hand) > 21;
}

export function isTwentyOne(hand: Hand): boolean {
  return handValue(hand) === 21;
}
