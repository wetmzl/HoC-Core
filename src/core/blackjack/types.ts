export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type Rank = (typeof RANKS)[number];

export type CardSource = "shoe" | "derived";

export interface CardAttributes {
  readonly source: CardSource;
  readonly suit: Suit;
  readonly rank: Rank;
}

export interface CardEntity {
  /** Stable identity while the entity moves between zones. */
  readonly id: string;
  /** Named, single-value facts about this card. */
  readonly attributes: CardAttributes;
  /** Extensible, value-free selectors. Duplicate tags are invalid. */
  readonly tags: readonly string[];
}

/** A finite physical card owned by the shoe/discard lifecycle. */
export interface PhysicalCard extends CardEntity {
  readonly attributes: CardAttributes & { readonly source: "shoe" };
}

/** A temporary card that exists only while it remains in the current hand. */
export interface DerivedCard extends CardEntity {
  readonly attributes: CardAttributes & { readonly source: "derived" };
}

export type Card = PhysicalCard | DerivedCard;

export interface Hand {
  readonly cards: readonly Card[];
}

export interface ShoeState {
  readonly cards: readonly PhysicalCard[];
  readonly cursor: number;
  /** Number of times this shoe has been shuffled; useful for save/debug output. */
  readonly shuffleIndex: number;
}

export type RoundStarter = "player" | "opponent";
