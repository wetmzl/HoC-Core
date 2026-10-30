import { describe, expect, it } from "vitest";
import { createMatch } from "../core/match/reducer";
import { createDefaultSave, createRuntimeSave } from "./boot";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";
import { MemorySaveStorageDriver } from "./memory-driver";
import { MemorySaveRepository } from "./memory-repository";
import { PersistenceService } from "./save-service";
import { CURRENT_GAME_VERSION, SaveValidationError, type RuntimeSave } from "./schema";
import type { SaveRepository } from "./repository";

function snapshots() {
  const previous = {
    longTerm: createDefaultSave("2026-10-28T00:00:00Z"),
    runtime: createRuntimeSave(createMatch("pending-result", { opponentId: "chatgpt" }), "2026-10-28T00:00:00Z")
  };
  const next = {
    longTerm: { ...previous.longTerm, profile: { ...previous.longTerm.profile, matchesPlayed: 1 } },
    runtime: createRuntimeSave(createMatch("continued-flow", { opponentId: "llama" }), "2026-10-28T00:01:00Z")
  };
  return { previous, next };
}

describe.each([
  ["memory repository", (initial: ReturnType<typeof snapshots>["previous"]): SaveRepository => new MemorySaveRepository(initial)],
  ["shared persistence service", (initial: ReturnType<typeof snapshots>["previous"]): SaveRepository => new PersistenceService(new MemorySaveStorageDriver(initial))]
] as const)("%s match result transactions", (_name, createRepository) => {
  it("keeps the supplied continuation with the durable result", async () => {
    const { previous, next } = snapshots(), repository = createRepository(previous);
    await repository.commitMatchResult(next.longTerm, next.runtime);
    expect(await repository.loadLongTerm()).toEqual(next.longTerm);
    expect(await repository.loadRuntime()).toEqual(next.runtime);
  });

  it.each([undefined, null])("clears the completed runtime when continuation is %s", async runtime => {
    const { previous, next } = snapshots(), repository = createRepository(previous);
    await repository.commitMatchResult(next.longTerm, runtime);
    expect(await repository.loadLongTerm()).toEqual(next.longTerm);
    expect(await repository.loadRuntime()).toBeNull();
  });

  it("leaves both records unchanged when the continuation is invalid", async () => {
    const { previous, next } = snapshots(), repository = createRepository(previous);
    const invalid = { ...next.runtime, schemaVersion: -1 } as unknown as RuntimeSave;
    await expect(repository.commitMatchResult(next.longTerm, invalid)).rejects.toBeInstanceOf(SaveValidationError);
    expect(await repository.loadLongTerm()).toEqual(previous.longTerm);
    expect(await repository.loadRuntime()).toEqual(previous.runtime);
  });
});

describe("platform snapshot boundary", () => {
  it("writes one snapshot, rolls both records back on storage failure, and permits a retry", async () => {
    const { previous, next } = snapshots(), driver = new MemorySaveStorageDriver(previous);
    let fail = true;
    const repository = new PersistenceService({
      readSnapshot: () => driver.readSnapshot(),
      writeSnapshot: async snapshot => {
        if (fail) { fail = false; throw new Error("result unavailable"); }
        await driver.writeSnapshot(snapshot);
      }
    });
    await expect(repository.commitMatchResult(next.longTerm, next.runtime)).rejects.toThrow("result unavailable");
    expect(await driver.readSnapshot()).toEqual(previous);
    expect(driver.writes).toHaveLength(0);
    await repository.commitMatchResult(next.longTerm, next.runtime);
    expect(driver.writes).toEqual([next]);
    const reopened = new PersistenceService(driver);
    expect(await reopened.loadLongTerm()).toEqual(next.longTerm);
    expect(await reopened.loadRuntime()).toEqual(next.runtime);
  });

  it("stamps both parts with the current release without mutating the inputs", async () => {
    const { previous, next } = snapshots(), driver = new MemorySaveStorageDriver(previous);
    const save = { ...next.longTerm, gameVersion: "0.0.1" }, runtime = { ...next.runtime, gameVersion: "0.0.1" };
    await new PersistenceService(driver).commitMatchResult(save, runtime);
    expect(await driver.readSnapshot()).toEqual({
      longTerm: { ...save, gameVersion: CURRENT_GAME_VERSION }, runtime: { ...runtime, gameVersion: CURRENT_GAME_VERSION }
    });
    expect(save.gameVersion).toBe("0.0.1"); expect(runtime.gameVersion).toBe("0.0.1");
  });

  it("preserves both native records after an interrupted A/B write, then reopens the committed continuation", async () => {
    const { previous, next } = snapshots(), files = new Map<string, string>();
    let interrupt = false;
    const port = {
      readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
      writeFile: async ({ path, data }: { path: string; data: string }) => {
        files.set(path, interrupt ? data.slice(0, data.length / 2) : data);
        if (interrupt) throw new Error("interrupted native write");
      }
    };
    const driver = new CapacitorFileSaveStorageDriver(port);
    await driver.writeSnapshot(previous);
    interrupt = true;
    await expect(new PersistenceService(driver).commitMatchResult(next.longTerm, next.runtime)).rejects.toThrow("interrupted native write");
    const reopenedDriver = new CapacitorFileSaveStorageDriver(port);
    expect(await reopenedDriver.readSnapshot()).toEqual(previous);
    interrupt = false;
    const repository = new PersistenceService(reopenedDriver);
    await repository.commitMatchResult(next.longTerm, next.runtime);
    expect(await new CapacitorFileSaveStorageDriver(port).readSnapshot()).toEqual(next);
    await repository.commitMatchResult(next.longTerm);
    expect(await new CapacitorFileSaveStorageDriver(port).readSnapshot()).toEqual({ ...next, runtime: null });
  });
});
