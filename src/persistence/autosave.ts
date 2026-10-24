import type { Action, MatchState } from "../core/match/types";
import { gameReducer } from "../core/match/reducer";
import { acknowledgeMatchResult, createRuntimeSave } from "./boot";
import type { LongTermSave } from "./schema";
import type { SaveRepository } from "./repository";

export interface AutosaveController {
  dispatch(action: Action): MatchState;
  updateSave(save: LongTermSave): void;
  flush(): Promise<void>;
  getState(): MatchState;
  getSave(): LongTermSave;
}

export interface AutosaveOptions {
  readonly now?: () => string;
}

/** Dispatches through the pure reducer and serializes each resulting domain state in order. */
export function createAutosaveController(repository: SaveRepository, save: LongTermSave, initialMatch: MatchState, options: AutosaveOptions = {}): AutosaveController {
  const now = options.now ?? (() => new Date().toISOString());
  let state = initialMatch;
  let currentSave = save;
  const initialSnapshot = createRuntimeSave(state, now());
  let queue: Promise<void> = Promise.resolve().then(() => repository.saveRuntime(initialSnapshot));

  const dispatch = (action: Action): MatchState => {
    const next = gameReducer(state, action);
    if (next === state) return state;
    state = next;
    if (next.status === "finished" && next.scene === "lobby") {
      currentSave = acknowledgeMatchResult(currentSave, next, now());
      const snapshot = currentSave;
      queue = queue.catch(() => undefined).then(() => repository.commitMatchResult(snapshot));
    } else {
      const snapshot = createRuntimeSave(next, now());
      queue = queue.catch(() => undefined).then(() => repository.saveRuntime(snapshot));
    }
    return state;
  };

  const updateSave = (next: LongTermSave): void => {
    currentSave = next;
    const snapshot = next;
    queue = queue.catch(() => undefined).then(() => repository.saveLongTerm(snapshot));
  };

  return { dispatch, updateSave, flush: () => queue, getState: () => state, getSave: () => currentSave };
}
