import Dexie, { type Table } from "dexie";
import type { RawSaveSnapshot, SaveStorageDriver } from "./storage-driver";

type SaveRecordId = "long-term" | "runtime" | "current" | "story" | "achievements" | "notebook";
interface SaveRecord { readonly id: SaveRecordId; readonly data: unknown; }

export class IndexedDbSaveStorageDriver implements SaveStorageDriver {
  private readonly db: DexieDatabase;

  constructor(databaseName = "house-of-chances") { this.db = new DexieDatabase(databaseName); }

  async readSnapshot(): Promise<RawSaveSnapshot | null> {
    return this.db.transaction("r", this.db.saves, async () => {
      const [longTerm, legacy, runtime, story, achievements, notebook] = await Promise.all([
        this.db.saves.get("long-term"),
        this.db.saves.get("current"),
        this.db.saves.get("runtime"), this.db.saves.get("story"), this.db.saves.get("achievements"), this.db.saves.get("notebook")
      ]);
      if (!longTerm && !legacy && !runtime && !story && !achievements && !notebook) return null;
      return { longTerm: (longTerm ?? legacy)?.data ?? null, runtime: runtime?.data ?? null,
        ...(story ? { story: story.data } : {}), ...(achievements ? { achievements: achievements.data } : {}), ...(notebook ? { notebook: notebook.data } : {}) };
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
      if (snapshot.story === null || snapshot.story === undefined) await this.db.saves.delete("story");
      else await this.db.saves.put({ id: "story", data: snapshot.story });
      if (snapshot.achievements === null || snapshot.achievements === undefined) await this.db.saves.delete("achievements");
      else await this.db.saves.put({ id: "achievements", data: snapshot.achievements });
      if (snapshot.notebook === null || snapshot.notebook === undefined) await this.db.saves.delete("notebook");
      else await this.db.saves.put({ id: "notebook", data: snapshot.notebook });
    });
  }

  async close(): Promise<void> { this.db.close(); }
}

class DexieDatabase extends Dexie {
  saves!: Table<SaveRecord, SaveRecordId>;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({ saves: "id" });
  }
}
