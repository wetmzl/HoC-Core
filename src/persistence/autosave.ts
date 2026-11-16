import type { Action, MatchState } from "../core/match/types";
import type { LongTermSave } from "./schema";
import type { MatchFactBatch } from "../core/events";
import type { MatchFactRuntime } from "../runtime/match-fact-runtime";

export interface AutosaveController {
  /** Internal event ownership; legacy controllers can continue implementing only the old port. */
  readonly factEvents?: MatchFactRuntime;
  getLastFactBatch?(): MatchFactBatch | undefined;
  dispatch(action: Action): MatchState;
  updateSave(save: LongTermSave): void;
  /** Serialize a durable mutation with the encounter's settlement transaction. */
  updateProgress?(update: (save: LongTermSave) => LongTermSave): Promise<void>;
  flush(): Promise<void>;
  getState(): MatchState;
  getSave(): LongTermSave;
}
