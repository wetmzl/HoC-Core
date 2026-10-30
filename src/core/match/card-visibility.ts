import type { MatchState } from "./types";

/** Public knowledge follows an entity through same-round transfers, but a new
 * round deals hidden cards afresh even when it reuses the same physical IDs. */
export function publicHandCardIds(state: MatchState): ReadonlySet<string> {
  const ids = new Set<string>();
  let start = state.history.length;
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const event = state.history[index];
    if (event.type === "ROUND_STARTED") {
      if (event.roundIndex === state.roundIndex) start = index + 1;
      break;
    }
  }
  for (const event of state.history.slice(start)) {
    if (event.type === "CARD_DEALT" && !event.private) ids.add(event.card.id);
    if (event.type === "CARD_REVEALED") ids.add(event.cardId);
  }
  for (const actor of ["player", "opponent"] as const) {
    const first = state[actor].hand.cards[0];
    if (first) ids.add(first.id);
  }
  return ids;
}
