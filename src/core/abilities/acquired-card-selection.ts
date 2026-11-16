import type { Card } from "../blackjack/types";
import type { AbilityActor, AbilityEventContext, AbilityWorld } from "./types";

/** Select the exact event identity as it currently exists in the acquiring hand. */
export function acquiredHandCard(world: AbilityWorld, actor: AbilityActor, event: AbilityEventContext): Card | undefined {
  if (event.trigger !== "after-card-acquired" || event.eventActor !== actor || event.acquiredCards?.length !== 1) return undefined;
  const id = event.acquiredCards[0]!.id;
  return world.hands[actor].cards.find(card => card.id === id);
}
