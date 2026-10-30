import type { MatchState } from "../core/match/types";
import type { CreateMatchOptions } from "../core/match/reducer";
import type { CharacterDefinition } from "../content/characters";
import type { AutosaveController } from "../persistence/autosave";

/** A prepared encounter contains no mode identity or mutable run state. */
export interface EncounterPlan {
  readonly opponentId: string;
  readonly seed: string;
  readonly options: CreateMatchOptions;
  /** Created once by the flow orchestrator, before the presentation layer opens. */
  readonly match?: MatchState;
}

/** The outer flow owns persistence and settlement; the table only plays a match. */
export interface MatchOwner {
  /** source is the authoritative table before optional intrinsic reconciliation. */
  attach(match: MatchState, source?: MatchState): Promise<AutosaveController>;
  character(base: CharacterDefinition, match: MatchState): CharacterDefinition;
  summary(match: MatchState): void;
}
