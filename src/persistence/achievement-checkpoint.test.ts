import { describe, expect, it } from "vitest";
import { createAchievementCheckpoint } from "../core/achievements/commit";
import { createAchievementLedger } from "../core/achievements/engine";
import { createMatch } from "../core/match/reducer";
import { createDefaultSave, createRuntimeSave } from "./boot";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";
import { MemorySaveStorageDriver } from "./memory-driver";
import { MemorySaveRepository } from "./memory-repository";
import { PersistenceService } from "./save-service";
import type { CheckpointSaveRepository, SaveRepository } from "./repository";
import type { RawSaveSnapshot } from "./storage-driver";

function fixture() {
  const longTerm = createDefaultSave("2026-11-11T00:00:00Z");
  const runtime = createRuntimeSave(createMatch("achievement-checkpoint", { opponentId: "llama" }), "2026-11-11T00:00:00Z");
  const achievements = { checkpoint: createAchievementCheckpoint(createAchievementLedger("profile")),
    gameplay: { matchId: runtime.activeMatch!.id, historyIndex: runtime.activeMatch!.history.length } };
  return { longTerm, runtime, achievements };
}

describe.each([
  ["memory repository", (initial: ReturnType<typeof fixture>): SaveRepository & CheckpointSaveRepository => new MemorySaveRepository(initial)],
  ["shared persistence service", (initial: ReturnType<typeof fixture>): SaveRepository & CheckpointSaveRepository => new PersistenceService(new MemorySaveStorageDriver(initial))]
] as const)("%s achievement checkpoint", (_name, createRepository) => {
  it("preserves the independent record through settings, settlement, runtime close and player reset", async () => {
    const initial = fixture(), repository = createRepository(initial);
    const save = { ...initial.longTerm, settings: { ...initial.longTerm.settings, soundEnabled: false } };
    await repository.saveLongTerm(save);
    await repository.saveRuntime(initial.runtime);
    await repository.commitMatchResult(save);
    await repository.closeGameRuntime(save);
    await repository.deleteLongTerm();
    expect(await repository.readSnapshot()).toEqual({ longTerm: null, runtime: null, achievements: initial.achievements });
    const detached = await repository.readSnapshot();
    (detached.achievements as { gameplay: { historyIndex: number } }).gameplay.historyIndex = -1;
    expect((await repository.readSnapshot()).achievements).toEqual(initial.achievements);
  });

  it("projects achievements alongside gameplay and exposes only the successful complete checkpoint", async () => {
    const initial = fixture(), repository = createRepository(initial);
    const observed: RawSaveSnapshot[] = [];
    repository.subscribeCheckpoints(snapshot => observed.push(structuredClone(snapshot)));
    const release = repository.addCheckpointProjector((_before, proposed, context) => ({ ...proposed,
      achievements: { ...initial.achievements, gameplay: { historyIndex: context.publicEvents?.length ?? 0 } } }));
    const next = await repository.projectSnapshot(current => ({ ...current, runtime: null }));
    expect(observed).toEqual([next]);
    expect(next).toMatchObject({ runtime: null, achievements: { gameplay: { historyIndex: 0 } } });
    release();
    await repository.saveLongTerm(initial.longTerm);
    expect((await repository.readSnapshot()).achievements).toEqual(next.achievements);
  });
});

it("keeps the old snapshot and observation cursor on failed writes, then retries from the durable baseline", async () => {
  const initial = fixture(), driver = new MemorySaveStorageDriver(initial);
  let unavailable = true;
  const repository = new PersistenceService({ readSnapshot: () => driver.readSnapshot(), writeSnapshot: next => {
    if (unavailable) throw new Error("disk unavailable");
    return driver.writeSnapshot(next);
  } });
  const successes: RawSaveSnapshot[] = [], baselines: unknown[] = [];
  repository.subscribeCheckpoints(snapshot => successes.push(snapshot));
  repository.addCheckpointProjector((previous, proposed) => {
    baselines.push(previous.achievements);
    return { ...proposed, achievements: { checkpoint: initial.achievements.checkpoint, gameplay: null } };
  });
  await expect(repository.commitMatchResult(initial.longTerm)).rejects.toThrow("disk unavailable");
  expect(await driver.readSnapshot()).toEqual(initial);
  expect(successes).toEqual([]);
  unavailable = false;
  await repository.commitMatchResult(initial.longTerm);
  expect(baselines).toEqual([initial.achievements, initial.achievements]);
  expect(successes).toHaveLength(1);
  expect(await driver.readSnapshot()).toEqual({ longTerm: initial.longTerm, runtime: null,
    achievements: { checkpoint: initial.achievements.checkpoint, gameplay: null } });
});

it("reads a legacy snapshot without manufacturing achievements or rewriting old save schemas", async () => {
  const { longTerm, runtime } = fixture(), driver = new MemorySaveStorageDriver({ longTerm, runtime });
  const repository = new PersistenceService(driver);
  expect(await repository.readSnapshot()).toEqual({ longTerm, runtime });
  expect(driver.writes).toEqual([]);
  await repository.saveLongTerm(longTerm);
  expect(await driver.readSnapshot()).toEqual({ longTerm, runtime });
});

it("retains all native records after an interrupted A/B write and commits the achievement cursor on retry", async () => {
  const initial = fixture(), files = new Map<string, string>();
  let interrupt = false;
  const port = {
    readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      files.set(path, interrupt ? data.slice(0, data.length / 2) : data);
      if (interrupt) throw new Error("interrupted native write");
    }
  };
  await new CapacitorFileSaveStorageDriver(port).writeSnapshot(initial);
  const next = { ...initial, runtime: null, achievements: { checkpoint: initial.achievements.checkpoint, gameplay: null } };
  const repository = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
  interrupt = true;
  await expect(repository.projectSnapshot(() => next)).rejects.toThrow("interrupted native write");
  expect(await new CapacitorFileSaveStorageDriver(port).readSnapshot()).toEqual(initial);
  interrupt = false;
  await repository.projectSnapshot(() => next);
  expect(await new CapacitorFileSaveStorageDriver(port).readSnapshot()).toEqual(next);
});
