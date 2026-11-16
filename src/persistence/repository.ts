import type { LongTermSave, RuntimeSave } from "./schema";
import type { PublicEventBatch } from "../core/events/public-events";
import type { MatchFactBatch } from "../core/events";
import type { RawSaveSnapshot } from "./storage-driver";

export interface SaveCheckpointContext {
  /** Acknowledging an achievement outbox must not produce gameplay observations. */
  readonly achievementOnly?: boolean;
  readonly publicEvents?: readonly PublicEventBatch[];
  /** Live reducer facts captured before save validation detaches event sidecars. Never persisted. */
  readonly matchFacts?: readonly MatchFactBatch[];
  /** Story-only writes must not derive gameplay events a second time. */
  readonly storyOnly?: boolean;
  /** Import replaces collection ownership rather than merging the previous player's entries. */
  readonly notebookReplacement?: boolean;
}
export type SaveCheckpointProjector = (previous: RawSaveSnapshot, proposed: RawSaveSnapshot, context: SaveCheckpointContext) => RawSaveSnapshot;
export interface CheckpointSaveRepository {
  /** Pure projection and every record are committed in one ordered storage transaction. */
  projectSnapshot(project: (snapshot: RawSaveSnapshot) => RawSaveSnapshot, context?: SaveCheckpointContext): Promise<RawSaveSnapshot>;
  readSnapshot(): Promise<RawSaveSnapshot>;
  addCheckpointProjector(projector: SaveCheckpointProjector): () => void;
  subscribeCheckpoints(listener: (snapshot: RawSaveSnapshot) => void): () => void;
  subscribeCheckpointFailures?(listener: (error: unknown) => void): () => void;
}

export interface SaveRepository {
  loadLongTerm(): Promise<LongTermSave | null>;
  saveLongTerm(save: LongTermSave): Promise<void>;
  deleteLongTerm(): Promise<void>;
  loadRuntime(): Promise<RuntimeSave | null>;
  saveRuntime(save: RuntimeSave, context?: SaveCheckpointContext): Promise<void>;
  deleteRuntime(context?: SaveCheckpointContext): Promise<void>;
  /** Atomically persists durable results with the next flow snapshot, or clears a completed runtime. */
  commitMatchResult(save: LongTermSave, runtime?: RuntimeSave | null, context?: SaveCheckpointContext): Promise<void>;
  /** Persists durable progress and removes any unfinished runtime before leaving the game shell. */
  closeGameRuntime(save: LongTermSave, context?: SaveCheckpointContext): Promise<void>;
}
