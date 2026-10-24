import type { GameEvent, MatchState } from "../core/match/types";

/** One immutable domain migration, shared by all presentation consumers. */
export interface MatchTransition {
  readonly before: MatchState;
  readonly after: MatchState;
  readonly events: readonly GameEvent[];
}

export function createMatchTransition(before: MatchState, after: MatchState): MatchTransition {
  return Object.freeze({ before, after, events: Object.freeze(after.history.slice(before.history.length)) });
}
