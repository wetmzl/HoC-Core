import { assertUniqueCardIds, createStandardDeck } from "./card";
import type { PhysicalCard, ShoeState } from "./types";
import { SeededRng } from "../rng/seeded";

export function shuffle<T>(items: readonly T[], rng: SeededRng): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.nextInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function createShoe(rng: SeededRng, deck: readonly PhysicalCard[] = createStandardDeck(rng.seed.replace(/[^a-zA-Z0-9_-]/g, "-"))): ShoeState {
  assertUniqueCardIds(deck);
  return { cards: shuffle(deck, rng), cursor: 0, shuffleIndex: 1 };
}

export function shoeRemaining(shoe: ShoeState): number {
  return Math.max(0, shoe.cards.length - shoe.cursor);
}

export function drawCard(shoe: ShoeState): { card: PhysicalCard; shoe: ShoeState } {
  if (shoe.cursor >= shoe.cards.length) throw new Error("Cannot draw from an empty shoe");
  return {
    card: shoe.cards[shoe.cursor],
    shoe: { ...shoe, cursor: shoe.cursor + 1 }
  };
}

export interface InitialDeal {
  readonly player: readonly [PhysicalCard, PhysicalCard];
  readonly opponent: readonly [PhysicalCard, PhysicalCard];
  readonly shoe: ShoeState;
}

/** Deal order is player public, opponent public, player private, opponent private. */
export function dealInitialHands(shoe: ShoeState): InitialDeal {
  let nextShoe = shoe;
  const draw = (): PhysicalCard => {
    const result = drawCard(nextShoe);
    nextShoe = result.shoe;
    return result.card;
  };
  const playerPublic = draw();
  const opponentPublic = draw();
  const playerPrivate = draw();
  const opponentPrivate = draw();
  return {
    player: [playerPublic, playerPrivate],
    opponent: [opponentPublic, opponentPrivate],
    shoe: nextShoe
  };
}

export function reshuffleIfLow(shoe: ShoeState, rng: SeededRng, threshold = 12): ShoeState {
  if (shoeRemaining(shoe) >= threshold) return shoe;
  return { cards: shuffle(shoe.cards, rng), cursor: 0, shuffleIndex: shoe.shuffleIndex + 1 };
}
