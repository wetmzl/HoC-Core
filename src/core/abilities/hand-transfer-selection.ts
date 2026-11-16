import { handValueAtLimit } from "../blackjack/hand";
import type { Card } from "../blackjack/types";
import type { AbilityActor, AbilityWorld } from "./types";

export interface HandTransferCandidate {
  readonly card: Card;
  readonly world: AbilityWorld;
}

/** Select against the complete transfer, including changes to either hand size. */
export function findHandTransferCandidates(
  world: AbilityWorld,
  from: AbilityActor,
  target: AbilityActor,
  bustLimitFor: (actor: AbilityActor, world: AbilityWorld) => number
): readonly HandTransferCandidate[] {
  if (from === target) return [];
  const candidates: HandTransferCandidate[] = [];
  for (const card of world.hands[from].cards) {
    if (world.hands[target].cards.some(entry => entry.id === card.id)) continue;
    const projected: AbilityWorld = {
      ...world,
      hands: {
        ...world.hands,
        [from]: { cards: world.hands[from].cards.filter(entry => entry.id !== card.id) },
        [target]: { cards: [...world.hands[target].cards, card] }
      }
    };
    const limit = bustLimitFor(target, projected);
    if (handValueAtLimit(projected.hands[target], limit) === limit) candidates.push({ card, world: projected });
  }
  return candidates;
}
