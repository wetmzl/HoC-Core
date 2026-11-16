import { expect, it, vi } from "vitest";
import { createAchievementLedger, advanceAchievements } from "../core/achievements/engine";
import { AchievementDefinitionSchema } from "../core/achievements/schema";
import { createAchievementCommitPort, type AchievementCheckpoint } from "../core/achievements/commit";
import { flushCommittedAchievementTelemetry } from "./achievement-telemetry";

const topic = { type: "example.checkpoint", apiVersion: 1 };
const key = "example/achievements#main/first";
function completed() {
  const before = createAchievementLedger("profile");
  const definition = AchievementDefinitionSchema.parse({ id: "first", revision: 1, name: "目标", description: "测试",
    tracking: { scope: "profile", tracks: [{ id: "n", progress: { type: "count" } }],
      completeWhen: { type: "scalar-compare", left: { type: "metric", id: "n" }, operator: "gte", right: 1 } } });
  return { before, after: advanceAchievements([{ key, definition }], before, { apiVersion: 1, streamId: "profile", sequence: 0,
    at: "2026-11-10T00:00:00Z", topic, scopes: {}, debugUsed: false, values: {}, skillCards: {} }, [{ topic, values: {}, skillCollections: [] }]).ledger };
}

it("does not expose failed progress saves to telemetry, and batches committed deliveries before ack", async () => {
  const { before, after } = completed();
  const save = vi.fn(async (_: AchievementCheckpoint) => {});
  save.mockRejectedValueOnce(new Error("progress write failed"));
  const port = createAchievementCommitPort({ initial: before, requiredConsumers: ["telemetry"], save });
  const telemetry = { recordAchievementUnlocks: vi.fn(async (_items: readonly { key: string }[]) => {}) };
  await expect(port.submit(after)).rejects.toThrow("progress write failed");
  await flushCommittedAchievementTelemetry(port, telemetry);
  expect(telemetry.recordAchievementUnlocks).not.toHaveBeenCalled();
  await port.submit(after);
  await flushCommittedAchievementTelemetry(port, telemetry);
  expect(telemetry.recordAchievementUnlocks).toHaveBeenCalledExactlyOnceWith([{ key, completion: after.records[key].completed, allowDebug: false }]);
  expect(port.committed.pending).toEqual([]);
  expect(port.committed.ledger).toEqual(after);
});

it("retains committed delivery through an outbox failure and retries it after checkpoint restoration", async () => {
  const { before, after } = completed();
  let stored: AchievementCheckpoint | undefined;
  const save = vi.fn(async (value: AchievementCheckpoint) => { stored = structuredClone(value); });
  const port = createAchievementCommitPort({ initial: before, requiredConsumers: ["telemetry", "reward"], save });
  await port.submit(after);
  const deliveryId = port.committed.pending[0].id;
  const telemetry = { recordAchievementUnlocks: vi.fn(async (_items: readonly { key: string }[]) => {}) };
  telemetry.recordAchievementUnlocks.mockRejectedValueOnce(new Error("telemetry disk unavailable"));
  await expect(flushCommittedAchievementTelemetry(port, telemetry)).rejects.toThrow("telemetry disk unavailable");
  expect(port.committed.pending[0].acknowledgedBy).toEqual([]);
  const restarted = createAchievementCommitPort({ initial: stored!, requiredConsumers: ["telemetry", "reward"], save });
  expect(await flushCommittedAchievementTelemetry(restarted, telemetry)).toEqual([deliveryId]);
  expect(restarted.committed.pending[0].acknowledgedBy).toEqual(["telemetry"]);
  expect(restarted.committed.pending[0].requiredConsumers).toEqual(["telemetry", "reward"]);
  await restarted.drain("reward", async delivery => { expect(delivery.id).toBe(deliveryId); });
  expect(restarted.committed.pending).toEqual([]);
});

it("does not acknowledge newly submitted deliveries that were not in the transferred batch", async () => {
  const { before, after } = completed();
  const port = createAchievementCommitPort({ initial: before, requiredConsumers: ["telemetry"], save: async () => {} });
  await port.submit(after);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const telemetry = { recordAchievementUnlocks: vi.fn(async (_items: readonly { key: string }[]) => { await gate; }) };
  const flushing = flushCommittedAchievementTelemetry(port, telemetry);
  const secondKey = "example/achievements#main/second";
  await port.submit({ ...after, nextSequence: 2, records: { ...after.records, [secondKey]: {
    ...after.records[key], completed: { ...after.records[key].completed!, sequence: 1 }
  } } });
  release();
  await flushing;
  expect(telemetry.recordAchievementUnlocks).toHaveBeenCalledTimes(2);
  expect(telemetry.recordAchievementUnlocks.mock.calls[1][0][0].key).toBe(secondKey);
  expect(port.committed.pending).toEqual([]);
});
