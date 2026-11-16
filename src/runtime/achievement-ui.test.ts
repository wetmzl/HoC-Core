import { expect, it, vi } from "vitest";
import { advanceAchievements } from "../core/achievements/engine";
import { AchievementDefinitionSchema } from "../core/achievements/schema";
import type { AchievementLedger } from "../core/achievements/types";
import type { AchievementPresentationEntry } from "../core/achievements/presentation";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { AchievementUiRuntime } from "./achievement-ui";

const topic = { type: "example.checkpoint", apiVersion: 1 };
const contract = [{ topic, values: {}, skillCollections: [] }];
function entry(id = "first", target = 1, hidden = false): AchievementPresentationEntry {
  return { key: `example/achievements#main/${id}`, coverUrl: `blob:${id}`, definition: AchievementDefinitionSchema.parse({
    id, revision: 1, name: `目标 ${id}`, description: "中性测试条件", cover: `${id}.png`, hidden,
    progressDisplay: { metric: "n", target },
    tracking: { scope: "profile", tracks: [{ id: "n", progress: { type: "count" } }],
      completeWhen: { type: "scalar-compare", left: { type: "metric", id: "n" }, operator: "gte", right: target } }
  }) };
}
function advance(entries: readonly AchievementPresentationEntry[], before: AchievementLedger) {
  return advanceAchievements(entries, before, { apiVersion: 1, streamId: before.streamId, sequence: before.nextSequence,
    at: "2026-11-10T01:00:00Z", topic, scopes: {}, debugUsed: false, values: {}, skillCards: {} }, contract).ledger;
}

it("loads a detached, read-only catalog with resolved covers and only an aggregate for hidden entries", async () => {
  const driver = new MemorySaveStorageDriver();
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  const entries = [entry(), entry("secret", 1, true)];
  runtime.installCatalog(entries);
  await runtime.ready();
  entries[0] = entry("replacement");
  expect(runtime.snapshot.status).toBe("ready");
  expect(runtime.snapshot.list.rows).toMatchObject([{ key: "example/achievements#main/first", cover: { type: "image", url: "blob:first" } }]);
  expect(runtime.snapshot.list.hiddenCount).toBe(1);
  expect(JSON.stringify(runtime.snapshot)).not.toContain("secret");
  expect(Object.isFrozen(runtime.snapshot.list.rows[0])).toBe(true);
  expect(driver.writes).toEqual([]);
});

it("notifies only after a durable save and does not notify failed or replayed submissions", async () => {
  const driver = new MemorySaveStorageDriver();
  const write = vi.spyOn(driver, "writeSnapshot");
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  const entries = [entry()];
  runtime.installCatalog(entries);
  await runtime.ready();
  const before = runtime.checkpoint!.ledger, after = advance(entries, before);
  const unlock = vi.fn(() => {
    expect(driver.writes[0].longTerm).toMatchObject({ ledger: after });
    expect(runtime.snapshot.list.rows[0].status).toBe("completed");
  });
  runtime.subscribeUnlocked(unlock);
  write.mockRejectedValueOnce(new Error("disk full"));
  await expect(runtime.submit(after, before)).rejects.toThrow("disk full");
  expect(runtime.checkpoint!.ledger).toEqual(before);
  expect(runtime.snapshot.list.rows[0].status).toBe("locked");
  expect(unlock).not.toHaveBeenCalled();
  await runtime.submit(after, before);
  expect(unlock).toHaveBeenCalledOnce();
  await runtime.submit(after);
  expect(unlock).toHaveBeenCalledOnce();
  expect(runtime.checkpoint!.pending).toEqual([]);
});

it("publishes committed progress even when the submission has no new unlock", async () => {
  const runtime = new AchievementUiRuntime(new MemorySaveStorageDriver(), () => "profile");
  const entries = [entry("progress", 3)];
  runtime.installCatalog(entries);
  await runtime.ready();
  const changed = vi.fn(), unlocked = vi.fn();
  runtime.subscribe(changed);
  runtime.subscribeUnlocked(unlocked);
  await runtime.submit(advance(entries, runtime.checkpoint!.ledger));
  expect(runtime.snapshot.list.rows[0]).toMatchObject({ status: "locked", progressDisplay: { target: 3, value: 1 } });
  expect(changed).toHaveBeenCalled();
  expect(unlocked).not.toHaveBeenCalled();
});

it("restores completions quietly and drops released catalog URLs without deleting permanent progress", async () => {
  const driver = new MemorySaveStorageDriver();
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  const entries = [entry("secret", 1, true)];
  runtime.installCatalog(entries);
  await runtime.ready();
  await runtime.submit(advance(entries, runtime.checkpoint!.ledger));
  const restarted = new AchievementUiRuntime(driver);
  const unlocked = vi.fn();
  restarted.subscribeUnlocked(unlocked);
  restarted.installCatalog(entries);
  await restarted.ready();
  expect(restarted.snapshot.list.rows[0].status).toBe("completed");
  expect(restarted.snapshot.list.hiddenCount).toBe(0);
  restarted.installCatalog([]);
  expect(restarted.snapshot.list).toEqual({ rows: [], hiddenCount: 0 });
  expect(JSON.stringify(restarted.snapshot)).not.toContain("blob:");
  restarted.installCatalog(entries);
  expect(restarted.snapshot.list.rows[0].status).toBe("completed");
  expect(unlocked).not.toHaveBeenCalled();
});

it("keeps read failures retryable and never replaces corrupt stored evidence", async () => {
  const driver = new MemorySaveStorageDriver();
  const read = vi.spyOn(driver, "readSnapshot").mockRejectedValueOnce(new Error("temporarily unavailable"));
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  await expect(runtime.ready()).rejects.toThrow("temporarily unavailable");
  expect(runtime.snapshot.status).toBe("error");
  expect(runtime.checkpoint).toBeUndefined();
  expect(driver.writes).toEqual([]);
  await runtime.ready();
  expect(read).toHaveBeenCalledTimes(2);
  expect(runtime.snapshot.status).toBe("ready");
  const corrupt = new MemorySaveStorageDriver({ longTerm: { broken: true }, runtime: null });
  const broken = new AchievementUiRuntime(corrupt);
  await expect(broken.ready()).rejects.toThrow();
  expect(broken.snapshot.status).toBe("error");
  expect(corrupt.writes).toEqual([]);
});

it("does not replay UI notifications when acknowledgement persistence fails", async () => {
  const driver = new MemorySaveStorageDriver();
  const write = vi.spyOn(driver, "writeSnapshot");
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  const entries = [entry()];
  runtime.installCatalog(entries);
  await runtime.ready();
  const unlocked = vi.fn();
  runtime.subscribeUnlocked(unlocked);
  write.mockImplementationOnce(async snapshot => { MemorySaveStorageDriver.prototype.writeSnapshot.call(driver, snapshot); })
    .mockRejectedValueOnce(new Error("ack failed"));
  const after = advance(entries, runtime.checkpoint!.ledger);
  await runtime.submit(after);
  expect(unlocked).toHaveBeenCalledOnce();
  expect(runtime.checkpoint!.pending).toHaveLength(1);
  const restored = new AchievementUiRuntime(driver);
  restored.subscribeUnlocked(unlocked);
  restored.installCatalog(entries);
  await restored.ready();
  expect(restored.checkpoint!.pending).toEqual([]);
  await restored.submit(after);
  expect(unlocked).toHaveBeenCalledOnce();
});

it("detaches listeners, isolates UI failures and coalesces simultaneous initialization", async () => {
  const driver = new MemorySaveStorageDriver();
  const read = vi.spyOn(driver, "readSnapshot");
  const runtime = new AchievementUiRuntime(driver, () => "profile");
  const entries = [entry()];
  runtime.installCatalog(entries);
  const removed = vi.fn(), active = vi.fn();
  runtime.subscribeUnlocked(removed)();
  runtime.subscribeUnlocked(() => { throw new Error("view unmounted"); });
  runtime.subscribeUnlocked(active);
  runtime.subscribe(() => { throw new Error("view unmounted"); });
  await Promise.all([runtime.ready(), runtime.ready()]);
  expect(read).toHaveBeenCalledOnce();
  await runtime.submit(advance(entries, runtime.checkpoint!.ledger));
  expect(active).toHaveBeenCalledOnce();
  expect(removed).not.toHaveBeenCalled();
});
