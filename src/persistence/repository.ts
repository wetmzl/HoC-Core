import type { LongTermSave, RuntimeSave } from "./schema";

export interface SaveRepository {
  loadLongTerm(): Promise<LongTermSave | null>;
  saveLongTerm(save: LongTermSave): Promise<void>;
  deleteLongTerm(): Promise<void>;
  loadRuntime(): Promise<RuntimeSave | null>;
  saveRuntime(save: RuntimeSave): Promise<void>;
  deleteRuntime(): Promise<void>;
  /** Atomically persists durable results with the next flow snapshot, or clears a completed runtime. */
  commitMatchResult(save: LongTermSave, runtime?: RuntimeSave | null): Promise<void>;
  /** Persists durable progress and removes any unfinished runtime before leaving the game shell. */
  closeGameRuntime(save: LongTermSave): Promise<void>;
}
