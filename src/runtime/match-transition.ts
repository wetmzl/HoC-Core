import type { GameEvent, MatchState } from "../core/match/types";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";

/** One immutable domain migration, shared by all presentation consumers. */
export interface MatchTransition {
  readonly before: MatchState;
  readonly after: MatchState;
  readonly events: readonly GameEvent[];
}

export interface MatchFactTransition extends MatchFactBatch {
  readonly before: MatchState;
}

export function createMatchTransition(before: MatchState, after: MatchState, facts?: MatchFactBatch): MatchFactTransition {
  if (facts && (facts.before !== before || facts.after !== after)) throw new Error("事实批次与牌局迁移不一致");
  return (facts ?? createMatchFactBatch(before, after)) as MatchFactTransition;
}
