import type { GunState } from "../roulette/types";
import type { Actor, MatchState } from "./types";

/**
 * The compact, immutable result kept for the Curator's collection history. The full MatchState
 * remains available while a match is active, but a completed match only needs
 * this summary to be restored and rendered later.
 */
export interface MatchHistoryRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly opponentId: string;
  readonly winner: Actor | null;
  readonly escaped: boolean;
  readonly finalRoulette: Readonly<Record<Actor, GunState>>;
  readonly busts: Readonly<Record<Actor, number>>;
  readonly blackjacks: Readonly<Record<Actor, number>>;
}

function countEvents(state: MatchState, type: "BUST" | "BLACKJACK"): Readonly<Record<Actor, number>> {
  const counts: Record<Actor, number> = { player: 0, opponent: 0 };
  for (const event of state.history) {
    if (event.type === type) counts[event.actor] += 1;
  }
  return counts;
}

/**
 * Builds a collection-history entry from a completed match without mutating it.
 * `timestamp` is supplied by the persistence boundary so this function stays
 * deterministic and straightforward to unit test.
 */
export function summarizeMatch(state: MatchState, timestamp: string): MatchHistoryRecord {
  if (state.status !== "finished" || !state.outcome) {
    throw new Error("Cannot summarize an unfinished match");
  }

  return {
    id: state.id,
    timestamp,
    opponentId: state.opponentId,
    winner: state.outcome.winner,
    escaped: state.outcome.reason === "escaped",
    finalRoulette: {
      player: { ...state.roulette.player },
      opponent: { ...state.roulette.opponent }
    },
    busts: countEvents(state, "BUST"),
    blackjacks: countEvents(state, "BLACKJACK")
  };
}
