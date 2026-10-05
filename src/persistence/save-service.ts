import { CURRENT_GAME_VERSION, validateLongTermSave, validateRuntimeSave, type LongTermSave, type RuntimeSave } from "./schema";
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

  private update(transform: (snapshot: RawSaveSnapshot) => RawSaveSnapshot): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const current = await this.driver.readSnapshot() ?? emptyRawSaveSnapshot();
      await this.driver.writeSnapshot(transform(current));
    });
    this.queue = operation;
    return operation;
  }

  async loadLongTerm(): Promise<LongTermSave | null> {
    const input = (await this.snapshot()).longTerm;
    return input === null ? null : validateLongTermSave(input);
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
