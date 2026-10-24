import { CURRENT_GAME_VERSION, SaveValidationError, validateLongTermSave, validateRuntimeSave, type LongTermSave, type RuntimeSave } from "./schema";
import { recoverLongTermSave } from "./recover-save";
import type { SaveRepository } from "./repository";
import { emptyRawSaveSnapshot, type RawSaveSnapshot, type SaveStorageDriver } from "./storage-driver";

/** Schema-validating repository shared by every host. Platform drivers only store opaque snapshots. */
export class PersistenceService implements SaveRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly driver: SaveStorageDriver) {}

  private async snapshot(): Promise<RawSaveSnapshot> {
    await this.queue.catch(() => undefined);
    return await this.driver.readSnapshot() ?? emptyRawSaveSnapshot();
  }

  private transact<T>(transform: (snapshot: RawSaveSnapshot) => { next?: RawSaveSnapshot; value: T }): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const current = await this.driver.readSnapshot() ?? emptyRawSaveSnapshot();
      const { next, value } = transform(current);
      if (next) await this.driver.writeSnapshot(next);
      return value;
    });
    this.queue = operation.then(() => undefined);
    // The caller observes operation; keep flush's failure without an unhandled queue rejection.
    void this.queue.catch(() => undefined);
    return operation;
  }

  private update(transform: (snapshot: RawSaveSnapshot) => RawSaveSnapshot): Promise<void> {
    return this.transact(current => ({ next: transform(current), value: undefined }));
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
    await this.update((current) => ({ ...current, longTerm: null }));
  }

  async loadRuntime(): Promise<RuntimeSave | null> {
    const input = (await this.snapshot()).runtime;
    return input === null ? null : validateRuntimeSave(input);
  }

  async saveRuntime(save: RuntimeSave): Promise<void> {
    const valid = validateRuntimeSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update((current) => ({ ...current, runtime: valid }));
  }

  async deleteRuntime(): Promise<void> {
    await this.update((current) => ({ ...current, runtime: null }));
  }

  async commitMatchResult(save: LongTermSave): Promise<void> {
    const valid = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update(() => ({ longTerm: valid, runtime: null }));
  }

  async closeGameRuntime(save: LongTermSave): Promise<void> {
    const valid = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
    await this.update(() => ({ longTerm: valid, runtime: null }));
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
