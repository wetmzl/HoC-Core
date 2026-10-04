import type { MatchState } from "../core/match/types";

export const AI_TURN_MIN_DELAY_MS = 2_000;
export const AI_TURN_MAX_DELAY_MS = 4_000;

/**
 * Presentation-only timing derived from saved state. It never consumes a game
 * RNG stream, so reloads stay reproducible and AI pacing cannot change rules.
 */
export function getAiTurnDelayMs(state: MatchState): number {
  const source = `${state.seed}:${state.roundIndex}:${state.history.length}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16_777_619);
  }
  return AI_TURN_MIN_DELAY_MS + ((hash >>> 0) % (AI_TURN_MAX_DELAY_MS - AI_TURN_MIN_DELAY_MS + 1));
}
