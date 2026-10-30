import { expect, it } from "vitest";
import { createDefaultSave, resetSave } from "./boot";
import { changeCharacterSkinUnlocks, isCharacterSkinUnlocked } from "./skin-unlocks";
import { validateLongTermSave } from "./schema";
import { recoverLongTermSave } from "./recover-save";
import { embedSaveInPng, exportSaveJson, importSave } from "./json";
import { PersistenceService } from "./save-service";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";

const key = "absent/character#match";
const appearance = { key, skinId: "initial", skins: [{ id: "initial", name: "初始" }, { id: "blue", name: "蓝色" }, { id: "green", name: "绿色" }] };

it("only grants the initial skin for new and legacy saves and keeps reset progress empty", () => {
  const save = createDefaultSave();
  delete save.characterSkinUnlocks;
  const legacy = validateLongTermSave(save);
  expect(isCharacterSkinUnlocked(legacy, appearance, "initial")).toBe(true);
  expect(isCharacterSkinUnlocked(legacy, appearance, "blue")).toBe(false);
  expect(isCharacterSkinUnlocked(legacy, appearance, "unknown")).toBe(false);
  expect(resetSave().characterSkinUnlocks).toEqual({});
  const unlocked = changeCharacterSkinUnlocks(legacy, appearance, { blue: true });
  expect(legacy.characterSkinUnlocks).toBeUndefined();
  expect(isCharacterSkinUnlocked(unlocked, appearance, "blue")).toBe(true);
  expect(isCharacterSkinUnlocked(unlocked, { ...appearance, key: "another/character#match" }, "blue")).toBe(false);
});

it("preserves absent content and explicit lock records through strict JSON and PNG roundtrips", async () => {
  const save = changeCharacterSkinUnlocks(createDefaultSave(), appearance, { blue: true, green: false });
  expect(await importSave(exportSaveJson(save))).toEqual(save);
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,174,66,96,130]);
  const bytes = embedSaveInPng(png, save);
  expect(await importSave({ arrayBuffer: async () => bytes.buffer } as File)).toEqual(save);
  const damaged = { ...save, characterSkinUnlocks: { [key]: { blue: true, green: false, broken: 1 }, "invalid key": { blue: true } } };
  expect(() => validateLongTermSave(damaged)).toThrow();
  const recovered = recoverLongTermSave(damaged);
  expect(recovered.characterSkinUnlocks).toEqual(save.characterSkinUnlocks);
  expect(recovered.recovery?.originals).toEqual([damaged]);
});

it("survives native driver recreation, settlement and runtime close without losing unlocks", async () => {
  const files = new Map<string, string>();
  const port = {
    readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
    writeFile: async ({ path, data }: { path: string; data: string }) => { files.set(path, data); }
  };
  const save = changeCharacterSkinUnlocks(createDefaultSave(), appearance, { blue: true });
  const repository = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
  await repository.saveLongTerm(save);
  for (const method of ["commitMatchResult", "closeGameRuntime"] as const) {
    await repository[method](save);
    const reopened = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
    expect((await reopened.loadLongTerm())?.characterSkinUnlocks).toEqual(save.characterSkinUnlocks);
  }
});
