import type { Action, MatchState } from "../core/match/types";
import type { LongTermSave } from "./schema";

export interface AutosaveController {
  dispatch(action: Action): MatchState;
  updateSave(save: LongTermSave): void;
  /** Serialize a durable mutation with the encounter's settlement transaction. */
  updateProgress?(update: (save: LongTermSave) => LongTermSave): Promise<void>;
  flush(): Promise<void>;
  getState(): MatchState;
  getSave(): LongTermSave;
}
