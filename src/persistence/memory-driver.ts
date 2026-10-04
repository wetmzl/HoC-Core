import { emptyRawSaveSnapshot, type RawSaveSnapshot, type SaveStorageDriver } from "./storage-driver";

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemorySaveStorageDriver implements SaveStorageDriver {
  private snapshot: RawSaveSnapshot | null;
  readonly writes: RawSaveSnapshot[] = [];

  constructor(initial: RawSaveSnapshot | null = null) {
    this.snapshot = initial ? copy(initial) : null;
  }

  async readSnapshot(): Promise<RawSaveSnapshot | null> {
    return this.snapshot ? copy(this.snapshot) : null;
  }

  async writeSnapshot(snapshot: RawSaveSnapshot): Promise<void> {
    this.snapshot = copy(snapshot ?? emptyRawSaveSnapshot());
    this.writes.push(copy(this.snapshot));
  }
}
