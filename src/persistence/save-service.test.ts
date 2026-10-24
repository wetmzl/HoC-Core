import { describe, expect, it } from "vitest";
import packageInfo from "../../package.json" with { type: "json" };
import archived from "../test/fixtures/archived-long-term-save.json";
import { bootLoad, createDefaultSave } from "./boot";
import { exportSaveJson, importSave } from "./json";
import { PersistenceService } from "./save-service";
import { SaveValidationError, validateLongTermSave } from "./schema";
import type { RawSaveSnapshot, SaveStorageDriver } from "./storage-driver";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";

function storage(longTerm: unknown = archived) {
  let snapshot: RawSaveSnapshot = { longTerm: structuredClone(longTerm), runtime: { marker: "unfinished" } };
  let writes = 0;
  let fail = false;
  const driver: SaveStorageDriver = {
    readSnapshot: async () => structuredClone(snapshot),
    writeSnapshot: async (next) => { if (fail) throw new Error("storage unavailable"); snapshot = structuredClone(next); writes++; }
  };
  return { repository: new PersistenceService(driver), read: () => snapshot, writes: () => writes, fail: () => { fail = true; } };
}

describe("release save compatibility", () => {
  it("reads the archived release shape without conversion or writes, including detached historical records", async () => {
    const store = storage();
    expect(await bootLoad(store.repository)).toEqual(archived);
    expect(await importSave(JSON.stringify(archived))).toEqual(archived);
    expect(store.read().longTerm).toEqual(archived);
    expect(store.writes()).toBe(0);
  });

  it.each([8, 99])("recovers compatible fields of schema %s while retaining the original and runtime", async (schemaVersion) => {
    const invalid = { ...archived, schemaVersion };
    const store = storage(invalid);
    const recovered = await bootLoad(store.repository);
    expect(recovered).toMatchObject({ ...archived, recovery: { originals: [invalid] } });
    expect(await importSave(JSON.stringify(invalid))).toEqual(recovered);
    expect(store.read()).toEqual({ longTerm: recovered, runtime: { marker: "unfinished" } });
    expect(store.writes()).toBe(1);
    expect(await bootLoad(store.repository)).toEqual(recovered);
    expect(store.writes()).toBe(1);
  });

  it("refuses unrelated JSON without modifying storage", async () => {
    const store = storage({ unrelated: true });
    await expect(bootLoad(store.repository)).rejects.toBeInstanceOf(SaveValidationError);
    await expect(importSave('{"unrelated":true}')).rejects.toBeInstanceOf(SaveValidationError);
    expect(store.writes()).toBe(0);
  });

  it("does not expose recovered progress if preserving its original fails", async () => {
    const invalid = { ...archived, schemaVersion: 8 };
    const store = storage(invalid); store.fail();
    await expect(bootLoad(store.repository)).rejects.toThrow("storage unavailable");
    expect(store.read()).toEqual({ longTerm: invalid, runtime: { marker: "unfinished" } });
  });

  it("serializes concurrent recovery reads and preserves originals through all normal save boundaries", async () => {
    const invalid = { ...archived, history: [...archived.history, null] };
    const store = storage(invalid);
    const [first, second] = await Promise.all([store.repository.loadLongTerm(), store.repository.loadLongTerm()]);
    expect(first).toEqual(second); expect(store.writes()).toBe(1);
    for (const method of ["saveLongTerm", "commitMatchResult", "closeGameRuntime"] as const) {
      await store.repository[method](first!);
      expect((await store.repository.loadLongTerm())?.recovery?.originals).toEqual([invalid]);
    }
  });

  it("persists the repaired save and its original through native A/B slots and driver recreation", async () => {
    const files = new Map<string, string>();
    const port = {
      readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
      writeFile: async ({ path, data }: { path: string; data: string }) => { files.set(path, data); }
    };
    const driver = new CapacitorFileSaveStorageDriver(port);
    const invalid = { ...archived, schemaVersion: 99, settings: { ...archived.settings, soundEnabled: "broken" } };
    const runtime = { marker: "unfinished" };
    await driver.writeSnapshot({ longTerm: invalid, runtime });
    const repository = new PersistenceService(driver);
    const recovered = await repository.loadLongTerm();
    expect(recovered?.settings.soundEnabled).toBe(true);
    expect(recovered?.recovery?.originals).toEqual([invalid]);
    await repository.saveLongTerm(recovered!);
    const reopened = new CapacitorFileSaveStorageDriver(port);
    expect((await reopened.readSnapshot())?.runtime).toEqual(runtime);
    expect((await new PersistenceService(reopened).loadLongTerm())?.recovery?.originals).toEqual([invalid]);
  });

  it.each(["saveLongTerm", "commitMatchResult", "closeGameRuntime"] as const)("%s stamps the actual release only on successful writes", async (method) => {
    const store = storage();
    const save = await bootLoad(store.repository);
    await store.repository[method](save);
    expect(store.read().longTerm).toEqual({ ...archived, gameVersion: packageInfo.version });
    expect(save.gameVersion).toBe("0.1.0");
    expect(store.read().runtime).toEqual(method === "saveLongTerm" ? { marker: "unfinished" } : null);
  });

  it("failed reset preserves the archived save and unfinished runtime", async () => {
    const store = storage();
    store.fail();
    await expect(store.repository.saveLongTerm(createDefaultSave())).rejects.toThrow("storage unavailable");
    expect(store.read()).toEqual({ longTerm: archived, runtime: { marker: "unfinished" } });
    expect(store.writes()).toBe(0);
  });

  it("new saves record the actual package release", () => { expect(createDefaultSave().gameVersion).toBe(packageInfo.version); expect(JSON.parse(exportSaveJson(validateLongTermSave(archived)))).toEqual({ ...archived, gameVersion: packageInfo.version }); expect(archived.gameVersion).toBe("0.1.0"); });
});
