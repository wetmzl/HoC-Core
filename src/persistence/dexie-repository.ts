import Dexie, { type Table } from "dexie";
import { PersistenceService } from "./save-service";
import type { RawSaveSnapshot, SaveStorageDriver } from "./storage-driver";

type SaveRecordId = "long-term" | "runtime" | "current";
interface SaveRecord { readonly id: SaveRecordId; readonly data: unknown; }

export class IndexedDbSaveStorageDriver implements SaveStorageDriver {
  private readonly db: DexieDatabase;

  constructor(databaseName = "house-of-chances") { this.db = new DexieDatabase(databaseName); }

  async readSnapshot(): Promise<RawSaveSnapshot | null> {
    return this.db.transaction("r", this.db.saves, async () => {
      const [longTerm, legacy, runtime] = await Promise.all([
        this.db.saves.get("long-term"),
        this.db.saves.get("current"),
        this.db.saves.get("runtime")
      ]);
      if (!longTerm && !legacy && !runtime) return null;
      return { longTerm: (longTerm ?? legacy)?.data ?? null, runtime: runtime?.data ?? null };
    });
  }

  async writeSnapshot(snapshot: RawSaveSnapshot): Promise<void> {
    await this.db.transaction("rw", this.db.saves, async () => {
      if (snapshot.longTerm === null) await this.db.saves.bulkDelete(["long-term", "current"]);
      else {
        await this.db.saves.put({ id: "long-term", data: snapshot.longTerm });
        await this.db.saves.delete("current");
      }
      if (snapshot.runtime === null) await this.db.saves.delete("runtime");
      else await this.db.saves.put({ id: "runtime", data: snapshot.runtime });
    });
  }

  async close(): Promise<void> { this.db.close(); }
}

/** Backwards-compatible typed facade for browser callers and tests. */
export class IndexedDbSaveRepository extends PersistenceService {
  constructor(databaseName = "house-of-chances") {
    super(new IndexedDbSaveStorageDriver(databaseName));
  }
}

class DexieDatabase extends Dexie {
  saves!: Table<SaveRecord, SaveRecordId>;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({ saves: "id" });
  }
}
