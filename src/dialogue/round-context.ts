import { handValue } from "../core/blackjack/hand";
import type { GameEvent, MatchState } from "../core/match/types";
import type { DialogueEvent } from "./types";

/**
 * Selects dialogue that depends on the completed hands rather than one event.
 */
export function roundOverrideDialogueEvent(state: MatchState): DialogueEvent | null {
  let resolutionIndex = -1;
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    if (state.history[index]?.type === "ROUND_RESOLVED") { resolutionIndex = index; break; }
  }
  if (resolutionIndex < 0) return null;
  const resolution = state.history[resolutionIndex];
  if (resolution.type !== "ROUND_RESOLVED") return null;
  if (state.round.phase !== "round-reveal") return null;

  let roundStartIndex = resolutionIndex;
  while (roundStartIndex >= 0 && state.history[roundStartIndex]?.type !== "ROUND_STARTED") roundStartIndex -= 1;
  const hands: Record<"player" | "opponent", Extract<GameEvent, { type: "CARD_DEALT" }>['card'][]> = { player: [], opponent: [] };
  for (const event of state.history.slice(Math.max(0, roundStartIndex), resolutionIndex)) {
    if (event.type === "HAND_REDEALT") hands[event.actor] = [];
    if (event.type === "CARD_DEALT") hands[event.actor].push(event.card);
  }
  const playerCards = hands.player;
  const opponentCards = hands.opponent;
  if (playerCards.length < 2 || opponentCards.length < 2) return resolution.outcome.winner === null ? "PUSH_ROUND" : null;

  const playerValue = handValue({ cards: playerCards });
  const opponentValue = handValue({ cards: opponentCards });
  if (resolution.outcome.winner === null && playerValue === 21 && opponentValue === 21) return "SPECIAL_TWENTY_ONE_PUSH";
  if (resolution.outcome.winner === null && playerValue === opponentValue && playerValue >= 12 && playerValue <= 16) return "SPECIAL_LOW_PUSH";
  return resolution.outcome.winner === null ? "PUSH_ROUND" : null;
}
