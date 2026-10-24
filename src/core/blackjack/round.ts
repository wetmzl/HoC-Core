import type { RoundStarter } from "./types";

/** roundIndex is zero-based. The Curator (player) starts every round. */
export function getRoundStarter(roundIndex: number): RoundStarter {
  if (!Number.isInteger(roundIndex) || roundIndex < 0) throw new RangeError("roundIndex must be a non-negative integer");
  return "player";
}
