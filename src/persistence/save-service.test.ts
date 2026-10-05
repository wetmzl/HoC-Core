import { describe, expect, it } from "vitest";
import packageInfo from "../../package.json" with { type: "json" };
import archived from "../test/fixtures/archived-long-term-save.json";
import { bootLoad, createDefaultSave } from "./boot";
import { exportSaveJson, importSave } from "./json";
import { PersistenceService } from "./save-service";
import { SaveValidationError, validateLongTermSave } from "./schema";
import type { RawSaveSnapshot, SaveStorageDriver } from "./storage-driver";

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

  it.each([8, 99])("rejects unsupported schema %s without changing either snapshot", async (schemaVersion) => {
    const invalid = { ...archived, schemaVersion };
    const store = storage(invalid);
    await expect(bootLoad(store.repository)).rejects.toMatchObject({ kind: "long-term", input: invalid });
    await expect(importSave(JSON.stringify(invalid))).rejects.toBeInstanceOf(SaveValidationError);
    expect(store.read()).toEqual({ longTerm: invalid, runtime: { marker: "unfinished" } });
    expect(store.writes()).toBe(0);
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
