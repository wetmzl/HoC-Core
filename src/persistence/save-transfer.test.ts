import { describe, expect, it } from "vitest";
import { createDefaultSave } from "./boot";
import { embedSaveInPng, exportSaveJson, importSave, importSaveTransfer } from "./json";
import { replaceTransferredSave } from "./save-transfer";
import { emptyStorySave } from "../runtime/story-checkpoint";
import { MemorySaveStorageDriver } from "./memory-driver";
import { PersistenceService } from "./save-service";
import { recoverLongTermSave } from "./recover-save";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
const story = { ...emptyStorySave(), once: ["saved-binding"], seen: ["saved-request"] };
describe("save-owned story transfer", () => {
  it("roundtrips JSON and PNG with the story ledger while accepting legacy progress", async () => {
    const save = createDefaultSave();
    const json = exportSaveJson(save, story);
    expect(await importSave(json)).toEqual(save);
    expect(await importSaveTransfer(json)).toEqual({ longTerm: save, story });
    const bytes = embedSaveInPng(png, save, story);
    expect(await importSaveTransfer({ arrayBuffer: async () => bytes.buffer } as File)).toEqual({ longTerm: save, story });
    expect(await importSaveTransfer(exportSaveJson(save))).toEqual({ longTerm: save, story: null });
    expect(JSON.parse(json).format).toBe(save.format);
    expect(JSON.parse(json).schemaVersion).toBe(save.schemaVersion);
    expect(recoverLongTermSave(JSON.parse(json))).toMatchObject({ profile: save.profile, createdAt: save.createdAt });
    await expect(importSaveTransfer(JSON.stringify({ ...save, storyTransfer: { format: "hoc-story-transfer", formatVersion: 99, story } }))).rejects.toThrow("不支持");
    await expect(importSaveTransfer(JSON.stringify({ ...save, storyTransfer: { format: "hoc-story-transfer", formatVersion: 1, story: { invalid: true } } }))).rejects.toThrow("剧情存档");
  });
  it("replaces independent saves atomically and preserves the previous checkpoint on failure", async () => {
    const first = createDefaultSave("2026-01-01T00:00:00.000Z"), second = createDefaultSave("2026-02-01T00:00:00.000Z");
    const driver = new MemorySaveStorageDriver({ longTerm: first, runtime: null, story });
    let fail = false;
    const repository = new PersistenceService({ readSnapshot: () => driver.readSnapshot(), writeSnapshot: snapshot => {
      if (fail) throw new Error("disk unavailable");
      return driver.writeSnapshot(snapshot);
    } });
    fail = true;
    await expect(replaceTransferredSave(repository, { longTerm: second, story: null })).rejects.toThrow("disk unavailable");
    expect(await driver.readSnapshot()).toEqual({ longTerm: first, runtime: null, story });
    fail = false;
    await replaceTransferredSave(repository, { longTerm: second, story: null });
    expect(await driver.readSnapshot()).toMatchObject({ longTerm: second, runtime: null, story: null });
    await replaceTransferredSave(repository, await importSaveTransfer(exportSaveJson(first, story)));
    expect(await driver.readSnapshot()).toMatchObject({ longTerm: first, story });
  });
});
