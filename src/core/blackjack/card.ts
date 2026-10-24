import { RANKS, SUITS, type Card, type CardSource, type DerivedCard, type PhysicalCard, type Rank, type Suit } from "./types";
import { SeededRng } from "../rng/seeded";

function assertCardId(id: string): string {
  if (id.trim().length === 0) throw new Error("Card ID must not be empty");
  return id;
}

function uniqueTags(tags: readonly string[]): readonly string[] {
  if (tags.some((tag) => tag.trim().length === 0)) throw new Error("Card tags must not be empty");
  if (new Set(tags).size !== tags.length) throw new Error("Card tags must be unique");
  return [...tags];
}

/** The default ID is suitable for a single standard deck, where each face exists once. */
export function createCard(suit: Suit, rank: Rank, id = `card-shoe-${suit}-${rank}`): PhysicalCard {
  return { id: assertCardId(id), attributes: { source: "shoe", suit, rank }, tags: [] };
}

export function createDerivedCard(suit: Suit, rank: Rank, id: string, generatedBy?: string, tags: readonly string[] = []): DerivedCard {
  const sourceTag = generatedBy ? [`generated-by:${generatedBy}`] : [];
  return { id: assertCardId(id), attributes: { source: "derived", suit, rank }, tags: uniqueTags(["derived", ...sourceTag, ...tags]) };
}

/** Consumes the saved ability stream so generated IDs replay with the same action. */
export function createDerivedCardId(rng: SeededRng): string {
  const state = rng.snapshot().state.toString(36).padStart(7, "0");
  rng.next();
  return `card-derived-${state}`;
}

export function cardRank(card: Card): Rank { return card.attributes.rank; }
export function cardSuit(card: Card): Suit { return card.attributes.suit; }
export function cardSource(card: Card): CardSource { return card.attributes.source; }
export function cardHasTag(card: Card, tag: string): boolean { return card.tags.includes(tag); }
export function addCardTag<T extends Card>(card: T, tag: string): T {
  if (tag.trim().length === 0) throw new Error("Card tags must not be empty");
  if (isPhysicalCard(card) && tag === "derived") throw new Error("A physical card cannot receive the derived source tag");
  return cardHasTag(card, tag) ? card : { ...card, tags: [...card.tags, tag] };
}
export function removeCardTag<T extends Card>(card: T, tag: string): T {
  if (isDerivedCard(card) && tag === "derived") throw new Error("The derived source tag cannot be removed");
  return cardHasTag(card, tag) ? { ...card, tags: card.tags.filter((entry) => entry !== tag) } : card;
}

export function assertUniqueCardIds(cards: readonly Card[]): void {
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new Error(`Duplicate card ID: ${card.id}`);
    ids.add(card.id);
  }
}

export function isPhysicalCard(card: Card): card is PhysicalCard {
  return card.attributes.source === "shoe";
}

export function isDerivedCard(card: Card): card is DerivedCard {
  return card.attributes.source === "derived";
}

export function createStandardDeck(namespace = "standard"): PhysicalCard[] {
  const identityRng = new SeededRng(`${namespace}:card-identities`);
  return SUITS.flatMap((suit) => RANKS.map((rank) => {
    const id = `card-shoe-${identityRng.snapshot().state.toString(36).padStart(7, "0")}`;
    identityRng.next();
    return createCard(suit, rank, id);
  }));
}

export function cardValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}
