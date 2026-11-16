import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, SaveValidationError, validateLongTermSave, validateRuntimeSave, type LongTermSave, type RuntimeSave } from "./schema";
import { recoverLongTermSave } from "./recover-save";
import type { SaveRepository, CheckpointSaveRepository, SaveCheckpointContext, SaveCheckpointProjector } from "./repository";
import { emptyRawSaveSnapshot, type RawSaveSnapshot, type SaveStorageDriver } from "./storage-driver";
import { projectNotebookSnapshot } from "./character-records";

/** Schema-validating repository shared by every host. Platform drivers only store opaque snapshots. */
export class PersistenceService implements SaveRepository, CheckpointSaveRepository {
  private queue: Promise<void> = Promise.resolve();
  private readonly projectors = new Set<SaveCheckpointProjector>();
  private readonly checkpointListeners = new Set<(snapshot: RawSaveSnapshot) => void>();
  private readonly failureListeners = new Set<(error: unknown) => void>();

  constructor(private readonly driver: SaveStorageDriver) {}

  private transact<T>(transform: (snapshot: RawSaveSnapshot) => { next?: RawSaveSnapshot; value: T }, context: SaveCheckpointContext = {}, committedValue?: (snapshot: RawSaveSnapshot) => T): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const current = await this.driver.readSnapshot() ?? emptyRawSaveSnapshot();
      const { next, value } = transform(current);
      if (next) {
        let projected = next;
        for (const projector of this.projectors) projected = projector(current, projected, context);
        projected = projectNotebookSnapshot(current, projected, context);
        await this.driver.writeSnapshot(projected);
        for (const listener of this.checkpointListeners) {
          try { listener(projected); } catch { /* Observers cannot roll back a committed checkpoint. */ }
        }
        if (committedValue) return committedValue(projected);
      }
      return value;
    }).catch(error => {
      for (const listener of this.failureListeners) { try { listener(error); } catch { /* Failure observers do not change the storage result. */ } }
      throw error;
    });
    this.queue = operation.then(() => undefined);
    // The caller observes operation; keep flush's failure without an unhandled queue rejection.
    void this.queue.catch(() => undefined);
    return operation;
  }

  private update(transform: (snapshot: RawSaveSnapshot) => RawSaveSnapshot, context?: SaveCheckpointContext): Promise<void> {
    return this.transact(current => ({ next: transform(current), value: undefined }), context);
  }

  addCheckpointProjector(projector: SaveCheckpointProjector): () => void { this.projectors.add(projector); return () => this.projectors.delete(projector); }
  subscribeCheckpoints(listener: (snapshot: RawSaveSnapshot) => void): () => void { this.checkpointListeners.add(listener); return () => this.checkpointListeners.delete(listener); }
  subscribeCheckpointFailures(listener: (error: unknown) => void): () => void { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }
  readSnapshot(): Promise<RawSaveSnapshot> { return this.transact(snapshot => ({ value: snapshot })); }
  async projectSnapshot(project: (snapshot: RawSaveSnapshot) => RawSaveSnapshot, context?: SaveCheckpointContext): Promise<RawSaveSnapshot> {
    return this.transact(current => {
      const projected = project(current);
      return { next: { ...projected,
        longTerm: projected.longTerm === current.longTerm || projected.longTerm === null ? projected.longTerm : validateLongTermSave(projected.longTerm),
        runtime: projected.runtime === current.runtime || projected.runtime === null ? projected.runtime : validateRuntimeSave(projected.runtime) }, value: current };
    }, context, committed => committed);
  }

  /** Startup feedback must not migrate, create or rewrite progress. */
  async readReducedMotion(): Promise<boolean> {
    return this.transact(current => {
      const save = current.longTerm as { settings?: { reducedMotion?: unknown } } | null;
      return { value: save?.settings?.reducedMotion === true };
    });
  }

  async loadLongTerm(): Promise<LongTermSave | null> {
    return this.transact(current => {
      if (current.longTerm === null) return { value: null };
      try { return { value: validateLongTermSave(current.longTerm) }; }
      catch (error) {
        if (!(error instanceof SaveValidationError)) throw error;
        const recovered = recoverLongTermSave(current.longTerm);
        // Never expose recovered progress until its original has been durably preserved.
        return { next: { ...current, longTerm: recovered }, value: recovered };
      }
    });
  }

  async saveLongTerm(save: LongTermSave): Promise<void> {
    const valid = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update((current) => ({ ...current, longTerm: valid }));
  }

  async deleteLongTerm(): Promise<void> {
    await this.update((current) => ({ ...current, longTerm: null, ...(current.story !== undefined ? { story: null } : {}) }));
  }

  async loadRuntime(): Promise<RuntimeSave | null> {
    return this.transact(current => {
      const runtime = current.runtime as { format?: unknown; schemaVersion?: unknown } | null;
      // Runtime snapshots are disposable; durable progress is deliberately untouched.
      if (runtime?.format === RUNTIME_SAVE_FORMAT && typeof runtime.schemaVersion === "number" && runtime.schemaVersion < CURRENT_RUNTIME_SCHEMA_VERSION)
        return { next: { ...current, runtime: null }, value: null };
      return { value: current.runtime === null ? null : validateRuntimeSave(current.runtime) };
    });
  }

  async saveRuntime(save: RuntimeSave, context?: SaveCheckpointContext): Promise<void> {
    const valid = validateRuntimeSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update((current) => ({ ...current, runtime: valid }), context);
  }

  async deleteRuntime(context?: SaveCheckpointContext): Promise<void> {
    await this.update((current) => ({ ...current, runtime: null }), context);
  }

  async commitMatchResult(save: LongTermSave, runtime: RuntimeSave | null = null, context?: SaveCheckpointContext): Promise<void> {
    const valid = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    const nextRuntime = runtime === null ? null : validateRuntimeSave({ ...runtime, gameVersion: CURRENT_GAME_VERSION });
    await this.update((current) => ({ ...current, longTerm: valid, runtime: nextRuntime }), context);
  }

  async closeGameRuntime(save: LongTermSave, context?: SaveCheckpointContext): Promise<void> {
    const valid = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update((current) => ({ ...current, longTerm: valid, runtime: null }), context);
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
