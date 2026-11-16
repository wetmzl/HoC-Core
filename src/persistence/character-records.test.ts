import { describe, expect, it } from "vitest";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createMatchFactBatch } from "../core/events";
import type { MatchState } from "../core/match/types";
import { acknowledgeMatchResult, clearMatchHistory, createDefaultSave } from "./boot";
import { NOTEBOOK_SAVE_FORMAT, NOTEBOOK_SAVE_SCHEMA_VERSION, NotebookSaveSchema, emptyNotebookSave, recordedCharacterIds, unlockedCharacterEndings, type NotebookEndingId } from "./character-records";
import { MemorySaveStorageDriver } from "./memory-driver";
import { MemorySaveRepository } from "./memory-repository";
import { PersistenceService } from "./save-service";
import { embedSaveInPng, exportSaveJson, importSaveTransfer } from "./json";
import { replaceTransferredSave } from "./save-transfer";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";
import { emptyStorySave } from "../runtime/story-checkpoint";

function result(id: string, outcome: NotebookEndingId, opponentId = "llama"): MatchState {
  const initial = createMatch(id, { id, opponentId, opponentAiSkills: [] });
  if (outcome === "escaped") return gameReducer(gameReducer(initial, { type: "ESCAPE_MATCH" }), { type: "ACK_MATCH_RESULT" });
  const actor = outcome === "playerVictory" ? "opponent" : "player", winner = outcome === "playerVictory" ? "player" : "opponent";
  const match: MatchState = { ...initial, roulette: { ...initial.roulette, [actor]: { ...initial.roulette[actor], bullets: initial.roulette[actor].capacity } },
    round: { ...initial.round, phase: "roulette-trigger", currentActor: null, outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
  return gameReducer(gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" }), { type: "ACK_MATCH_RESULT" });
}
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
const collected = { ...emptyNotebookSave(), characters: [{ characterId: "absent/person", endings: ["playerDefeat" as const] }] };

describe("permanent notebook character records", () => {
  it("derives only proven legacy endings without rewriting the save or inventing a victory for defeats", () => {
    const save = acknowledgeMatchResult(createDefaultSave(), result("loss", "playerDefeat"));
    save.defeats.push({ opponentId: "missing-person", timestamp: "2026-01-01T00:00:00.000Z" });
    const original = structuredClone(save);
    expect(recordedCharacterIds(save)).toEqual(["llama", "missing-person"]);
    expect(unlockedCharacterEndings(save, undefined, "llama")).toEqual(["playerDefeat"]);
    expect(unlockedCharacterEndings(save, undefined, "missing-person")).toEqual(["playerVictory"]);
    expect(save).toEqual(original);
  });

  it.each(["playerVictory", "playerDefeat", "escaped"] as const)("records %s with the source checkpoint even without a history effect", async outcome => {
    const save = createDefaultSave(), driver = new MemorySaveStorageDriver({ longTerm: save, runtime: null });
    const repository = new PersistenceService(driver), match = result(outcome, outcome);
    await repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, match)] });
    const stored = await repository.readSnapshot();
    expect(stored.longTerm).toEqual(save);
    expect(unlockedCharacterEndings(save, stored.notebook, "llama")).toEqual([outcome]);
    expect(recordedCharacterIds(save, stored.notebook)).toEqual(["llama"]);
    await repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, match)] });
    expect((await repository.readSnapshot()).notebook).toEqual(stored.notebook);
  });

  it("never collects an unfinished table or reinterprets restoration as a newly witnessed ending", async () => {
    const save = createDefaultSave(), repository = new PersistenceService(new MemorySaveStorageDriver({ longTerm: save, runtime: null }));
    await repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, createMatch("active", { opponentId: "llama" }))] });
    await repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, result("restored", "playerDefeat"), { restored: true })] });
    expect((await repository.readSnapshot()).notebook).toBeUndefined();
  });

  it.each(["shared", "memory"] as const)("%s preserves all three observed endings and absent character IDs after history cleanup", async kind => {
    let save = createDefaultSave();
    for (const outcome of ["playerVictory", "playerDefeat", "escaped"] as const) save = acknowledgeMatchResult(save, result(outcome, outcome));
    save.history.push({ ...save.history[1], id: "uninstalled", opponentId: "uninstalled-character" });
    const repository = kind === "shared" ? new PersistenceService(new MemorySaveStorageDriver({ longTerm: save, runtime: null })) : new MemorySaveRepository({ longTerm: save, runtime: null });
    expect((await repository.readSnapshot()).notebook).toBeUndefined();
    await repository.saveLongTerm(clearMatchHistory(save));
    const snapshot = await repository.readSnapshot();
    expect((await repository.loadLongTerm())!.history).toEqual([]);
    expect(unlockedCharacterEndings((await repository.loadLongTerm())!, snapshot.notebook, "llama")).toEqual(["playerVictory", "playerDefeat", "escaped"]);
    expect(unlockedCharacterEndings((await repository.loadLongTerm())!, snapshot.notebook, "uninstalled-character")).toEqual(["playerDefeat"]);
    const cleared = (await repository.loadLongTerm())!;
    for (const imported of [await importSaveTransfer(exportSaveJson(cleared, undefined, snapshot.notebook)),
      await importSaveTransfer({ arrayBuffer: async () => embedSaveInPng(png, cleared, undefined, snapshot.notebook).buffer } as File)]) {
      expect(unlockedCharacterEndings(imported.longTerm, imported.notebook, "llama")).toEqual(["playerVictory", "playerDefeat", "escaped"]);
      expect(recordedCharacterIds(imported.longTerm, imported.notebook)).toContain("uninstalled-character");
    }
    await repository.deleteLongTerm();
    expect((await repository.readSnapshot()).notebook).toBeNull();
  });

  it("rolls collection and ending unlocks back with a failed gameplay write, then retries", async () => {
    const save = createDefaultSave(), driver = new MemorySaveStorageDriver({ longTerm: save, runtime: null });
    let fail = true;
    const repository = new PersistenceService({ readSnapshot: () => driver.readSnapshot(), writeSnapshot: snapshot => {
      if (fail) throw new Error("disk unavailable"); return driver.writeSnapshot(snapshot);
    } });
    const match = result("atomic-loss", "playerDefeat");
    await expect(repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, match)] })).rejects.toThrow("disk unavailable");
    expect((await repository.readSnapshot()).notebook).toBeUndefined();
    fail = false;
    await repository.commitMatchResult(save, null, { matchFacts: [createMatchFactBatch(undefined, match)] });
    expect(unlockedCharacterEndings(save, (await repository.readSnapshot()).notebook, "llama")).toEqual(["playerDefeat"]);
  });

  it("roundtrips an independent notebook through JSON and PNG while old saves retain their original shape", async () => {
    const save = createDefaultSave();
    const expected = { longTerm: save, story: null, notebook: collected };
    expect(await importSaveTransfer(exportSaveJson(save, undefined, collected))).toEqual(expected);
    const bytes = embedSaveInPng(png, save, undefined, collected);
    expect(await importSaveTransfer({ arrayBuffer: async () => bytes.buffer } as File)).toEqual(expected);
    expect(await importSaveTransfer(exportSaveJson(save))).toEqual({ longTerm: save, story: null });
    expect(JSON.parse(exportSaveJson(save, undefined, collected)).schemaVersion).toBe(9);
    expect(await importSaveTransfer(exportSaveJson(save, emptyStorySave(), collected))).toEqual({ ...expected, story: emptyStorySave() });
    await expect(importSaveTransfer(JSON.stringify({ ...save, notebookTransfer: { format: "hoc-notebook-transfer", formatVersion: 1 } }))).rejects.toThrow("人物记录");
    await expect(importSaveTransfer(JSON.stringify({ ...save, notebookTransfer: { format: "hoc-notebook-transfer", formatVersion: 99, notebook: collected } }))).rejects.toThrow("传输版本");
  });

  it("replaces collections on import instead of merging the previous player's unlocked endings", async () => {
    const save = createDefaultSave(), repository = new PersistenceService(new MemorySaveStorageDriver({ longTerm: save, runtime: null, notebook: collected }));
    const loss = acknowledgeMatchResult(save, result("legacy-import", "playerDefeat"));
    await replaceTransferredSave(repository, { longTerm: loss, story: null });
    expect(recordedCharacterIds(loss, (await repository.readSnapshot()).notebook)).toEqual(["llama"]);
    expect(unlockedCharacterEndings(loss, (await repository.readSnapshot()).notebook, "llama")).toEqual(["playerDefeat"]);
    await replaceTransferredSave(repository, { longTerm: save, story: null, notebook: collected });
    expect(recordedCharacterIds(save, (await repository.readSnapshot()).notebook)).toEqual(["absent/person"]);
  });

  it("retains the complete raw import when an invalid story accompanies a valid notebook", async () => {
    const original = { ...JSON.parse(exportSaveJson(createDefaultSave(), emptyStorySave(), collected)), storyTransfer: { format: "hoc-story-transfer", formatVersion: 1, story: { broken: true } } };
    let caught: any;
    try { await importSaveTransfer(JSON.stringify(original)); } catch (error) { caught = error; }
    expect(caught.input).toEqual(original);
    expect(caught.input.notebookTransfer.notebook).toEqual(collected);
  });

  it("keeps the previous notebook ending set through an interrupted native result write", async () => {
    const files = new Map<string, string>(); let interrupt = false;
    const port = {
      readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
      writeFile: async ({ path, data }: { path: string; data: string }) => { files.set(path, interrupt ? data.slice(0, data.length / 2) : data); if (interrupt) throw new Error("interrupted write"); }
    };
    const initial = { longTerm: createDefaultSave(), runtime: null, notebook: collected };
    await new CapacitorFileSaveStorageDriver(port).writeSnapshot(initial);
    const repository = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
    const match = result("native-ending", "escaped"), context = { matchFacts: [createMatchFactBatch(undefined, match)] };
    interrupt = true;
    await expect(repository.commitMatchResult(initial.longTerm, null, context)).rejects.toThrow("interrupted write");
    expect(await new CapacitorFileSaveStorageDriver(port).readSnapshot()).toEqual(initial);
    interrupt = false;
    await repository.commitMatchResult(initial.longTerm, null, context);
    const restored = await new CapacitorFileSaveStorageDriver(port).readSnapshot();
    expect(recordedCharacterIds(initial.longTerm, restored?.notebook)).toEqual(["absent/person", "llama"]);
    expect(unlockedCharacterEndings(initial.longTerm, restored?.notebook, "llama")).toEqual(["escaped"]);
  });

  it("uses the opaque native snapshot envelope without advancing long-term or runtime schema", async () => {
    const files = new Map<string, string>(), driver = new CapacitorFileSaveStorageDriver({
      readFile: async ({ path }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
      writeFile: async ({ path, data }) => { files.set(path, data); }
    });
    const initial = { longTerm: createDefaultSave(), runtime: null, notebook: collected };
    await driver.writeSnapshot(initial);
    expect(await new CapacitorFileSaveStorageDriver({ readFile: async ({ path }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; }, writeFile: async () => {} }).readSnapshot()).toEqual(initial);
    expect(initial.longTerm.schemaVersion).toBe(9);
    expect(collected).toMatchObject({ format: NOTEBOOK_SAVE_FORMAT, schemaVersion: NOTEBOOK_SAVE_SCHEMA_VERSION });
    expect(NotebookSaveSchema.safeParse({ ...collected, characters: [...collected.characters, ...collected.characters] }).success).toBe(false);
  });
});
