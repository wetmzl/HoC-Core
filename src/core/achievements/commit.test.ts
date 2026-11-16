import { describe, expect, it, vi } from "vitest";
import { advanceAchievements, createAchievementLedger } from "./engine";
import { AchievementDefinitionSchema } from "./schema";
import { AchievementCheckpointSchema, AchievementCommitPort, AchievementUnlockDeliverySchema, AchievementUnlockRequirementSchema,
  createAchievementCheckpoint, createAchievementCommitPort, createAchievementUnlockDeliveryId, isAchievementUnlocked,
  meetsAchievementUnlockRequirement, restoreAchievementCheckpoint, type AchievementCheckpoint, type AchievementUnlockDelivery } from "./commit";
import type { AchievementDefinitionEntry, AchievementLedger, AchievementObservationContract } from "./types";

const alpha = "example/package#achievements/alpha", beta = "example/package#achievements/beta";
const topic = { type: "example/progress", apiVersion: 1 } as const;
const contracts: readonly AchievementObservationContract[] = [{ topic, values: { target: "string" }, skillCollections: [] }];
const entries: readonly AchievementDefinitionEntry[] = ["alpha", "beta"].map(id => ({ key: `example/package#achievements/${id}`,
  definition: AchievementDefinitionSchema.parse({ id, revision: 1, name: id, description: "Neutral completion", tracking: {
    scope: "profile", tracks: [{ id: "steps", on: [topic], when: { type: "value-compare", left: { type: "observation", key: "target" }, operator: "eq", right: { type: "literal", value: id } }, progress: { type: "count" } }],
    completeWhen: { type: "scalar-compare", left: { type: "metric", id: "steps" }, operator: "gte", right: 1 }
  } }) }));
const initial = createAchievementLedger("example-profile");
function progress(before: AchievementLedger, target: string): AchievementLedger {
  return advanceAchievements(entries, before, { apiVersion: 1, streamId: before.streamId, sequence: before.nextSequence,
    at: "2026-11-10T01:00:00.000Z", topic, scopes: {}, debugUsed: false, values: { target }, skillCards: {} }, contracts).ledger;
}
const afterA = progress(initial, "alpha"), afterB = progress(afterA, "beta");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function port(save = vi.fn(async (_checkpoint: AchievementCheckpoint) => {}), requiredConsumers = ["telemetry"]) {
  return createAchievementCommitPort({ initial, requiredConsumers, save });
}
function delivery(ledger: AchievementLedger, key: string, requiredConsumers = ["telemetry"]): AchievementUnlockDelivery {
  const record = ledger.records[key];
  return { id: createAchievementUnlockDeliveryId(ledger.streamId, key, record.completed!), key, completion: record.completed!,
    allowDebug: record.tracking.allowDebug, requiredConsumers, acknowledgedBy: [] };
}

describe("durable achievement commit port", () => {
  it("publishes neither a baseline nor an unlock when the atomic save fails", async () => {
    const save = vi.fn(async () => { throw new Error("disk unavailable"); });
    const value = port(save);
    const observed = vi.fn(); value.subscribeCommitted(observed);
    const before = value.committed;
    await expect(value.submit(afterA)).rejects.toThrow("disk unavailable");
    expect(value.committed).toBe(before);
    expect(value.committed.pending).toEqual([]);
    expect(value.isAchievementUnlocked(alpha)).toBe(false);
    expect(observed).not.toHaveBeenCalled();
  });

  it("recovers failed A when the next submission includes A and B", async () => {
    let fail = true;
    const save = vi.fn(async (_checkpoint: AchievementCheckpoint) => { if (fail) throw new Error("failed A"); });
    const value = port(save), observed = vi.fn(); value.subscribeCommitted(observed);
    await expect(value.submit(afterA)).rejects.toThrow("failed A");
    fail = false;
    const receipt = await value.submit(afterB, initial);
    expect(receipt.deliveries.map(item => [item.key, item.completion.sequence])).toEqual([[alpha, 0], [beta, 1]]);
    expect(value.committed.pending).toEqual(receipt.deliveries);
    expect(value.committed.ledger.nextSequence).toBe(2);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("announces only after saving the complete ledger and pending envelope", async () => {
    const entered = deferred(), release = deferred();
    const save = vi.fn(async (checkpoint: AchievementCheckpoint) => { expect(checkpoint.pending).toHaveLength(1); entered.resolve(); await release.promise; });
    const value = port(save), observed = vi.fn(); value.subscribeCommitted(observed);
    const submitting = value.submit(afterA);
    await entered.promise;
    expect(observed).not.toHaveBeenCalled();
    expect(value.isAchievementUnlocked(alpha)).toBe(false);
    release.resolve();
    const receipt = await submitting;
    expect(value.isAchievementUnlocked(alpha)).toBe(true);
    expect(receipt.after).toBe(value.committed.ledger);
    expect(observed).toHaveBeenCalledWith(receipt);
  });

  it("replays the same ledger without saving or creating another pending delivery", async () => {
    const save = vi.fn(async (_checkpoint: AchievementCheckpoint) => {}), value = port(save);
    const first = await value.submit(afterA), observed = vi.fn(); value.subscribeCommitted(observed);
    const checkpoint = value.committed;
    const replay = await value.submit(clone(afterA));
    expect(replay).toMatchObject({ deliveries: [], replayed: true });
    expect(value.committed).toBe(checkpoint);
    expect(value.committed.pending[0].id).toBe(first.deliveries[0].id);
    expect(save).toHaveBeenCalledTimes(1);
    expect(observed).not.toHaveBeenCalled();
  });

  it("checks a detached expected durable baseline, not object identity", async () => {
    const value = port();
    await value.submit(afterA, clone(initial));
    await expect(value.submit(afterB, initial)).rejects.toThrow(/基线/);
    await value.submit(afterB, clone(afterA));
    expect(value.committed.ledger).toEqual(afterB);
  });

  it("rejects a foreign stream, rewinding and rewriting a consumed cursor", async () => {
    const value = port(); await value.submit(afterA);
    await expect(value.submit(progress(createAchievementLedger("other-profile"), "alpha"))).rejects.toThrow(/持久流/);
    await expect(value.submit(initial)).rejects.toThrow(/倒退/);
    const rewritten = clone(afterA); (rewritten.records[alpha] as { suspended: boolean }).suspended = true;
    await expect(value.submit(rewritten)).rejects.toThrow(/相同消费位置/);
  });

  it.each(["deleted", "timestamp", "rules", "statistics"])("rejects %s changes to an already completed identity", async change => {
    const value = port(); await value.submit(afterA);
    const changed = clone(afterB);
    if (change === "deleted") delete (changed.records as Record<string, unknown>)[alpha];
    if (change === "timestamp") (changed.records[alpha].completed as { at: string }).at = "2026-11-10T02:00:00.000Z";
    if (change === "rules") (changed.records[alpha].tracking as { allowDebug: boolean }).allowDebug = true;
    if (change === "statistics") (changed.records[alpha].metrics.steps as { value: number }).value = 9;
    await expect(value.submit(changed)).rejects.toThrow(/已完成/);
    expect(value.committed.ledger).toEqual(afterA);
  });

  it("permits suspension of a preserved completed identity without issuing another delivery", async () => {
    const value = port(); await value.submit(afterA);
    const suspended = clone(afterB); (suspended.records[alpha] as { suspended: boolean }).suspended = true;
    const receipt = await value.submit(suspended);
    expect(receipt.deliveries.map(item => item.key)).toEqual([beta]);
  });

  it("rejects new completion evidence from before the newly consumed interval", async () => {
    const value = port(); await value.submit(afterA);
    const forged = clone(afterB); (forged.records[beta].completed as { sequence: number }).sequence = 0;
    await expect(value.submit(forged)).rejects.toThrow(/新增消费范围/);
    const beyond = clone(afterB); (beyond.records[beta].completed as { sequence: number }).sequence = 2;
    await expect(value.submit(beyond)).rejects.toThrow();
  });

  it("serializes concurrent submissions while preserving both unlocks", async () => {
    const gate = deferred(); let calls = 0;
    const save = vi.fn(async (_checkpoint: AchievementCheckpoint) => { if (++calls === 1) await gate.promise; });
    const value = port(save);
    const a = value.submit(afterA, initial), b = value.submit(afterB, afterA);
    gate.resolve(); await Promise.all([a, b]);
    expect(value.committed.ledger).toEqual(afterB);
    expect(value.committed.pending.map(item => item.key)).toEqual([alpha, beta]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("isolates synchronous and asynchronous presentation observer failures", async () => {
    const errors = vi.fn(), success = vi.fn();
    const value = createAchievementCommitPort({ initial, requiredConsumers: ["telemetry"], save: async () => {}, onObserverError: errors });
    value.subscribeCommitted(() => { throw new Error("presentation failed"); });
    value.subscribeCommitted(async () => { throw new Error("async presentation failed"); });
    value.subscribeCommitted(success);
    const receipt = await value.submit(afterA);
    await Promise.resolve();
    expect(success).toHaveBeenCalledWith(receipt);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(value.isAchievementUnlocked(alpha)).toBe(true);
    expect(value.committed.pending).toHaveLength(1);
  });

  it("releases presentation observers by unsubscribe or an aborted lifetime", async () => {
    const value = port(), removed = vi.fn(), expired = vi.fn(), controller = new AbortController();
    value.subscribeCommitted(removed)();
    value.subscribeCommitted(expired, { signal: controller.signal }); controller.abort();
    await value.submit(afterA);
    expect(removed).not.toHaveBeenCalled(); expect(expired).not.toHaveBeenCalled();
  });

  it("retains a failed consumer job for a later retry", async () => {
    const save = vi.fn(async (_checkpoint: AchievementCheckpoint) => {}), value = port(save);
    await value.submit(afterA);
    const identity = value.committed.pending[0].id;
    await expect(value.drain("telemetry", async () => { throw new Error("outbox unavailable"); })).rejects.toThrow("outbox unavailable");
    expect(value.committed.pending[0]).toMatchObject({ id: identity, acknowledgedBy: [] });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await value.drain("telemetry", () => {})).toEqual([identity]);
    expect(value.committed.pending).toEqual([]);
  });

  it("redelivers the stable ID when work succeeded but saving its acknowledgement failed", async () => {
    let writes = 0;
    const save = vi.fn(async (_checkpoint: AchievementCheckpoint) => { if (++writes === 2) throw new Error("ack disk failure"); });
    const value = port(save); await value.submit(afterA);
    const awarded = new Set<string>(), seen: string[] = [];
    const handler = (item: AchievementUnlockDelivery) => { seen.push(item.id); awarded.add(item.id); };
    await expect(value.drain("telemetry", handler)).rejects.toThrow("ack disk failure");
    expect(value.committed.pending[0].acknowledgedBy).toEqual([]);
    await value.drain("telemetry", handler);
    expect(seen).toHaveLength(2); expect(seen[0]).toBe(seen[1]);
    expect(awarded.size).toBe(1);
    expect(value.committed.pending).toEqual([]);
  });

  it("restores pending work after restart without fabricating a second completion notification", async () => {
    let saved = createAchievementCheckpoint(initial);
    const first = createAchievementCommitPort({ initial: saved, requiredConsumers: ["telemetry"], save: async checkpoint => { saved = clone(checkpoint); } });
    const receipt = await first.submit(afterA);
    const second = createAchievementCommitPort({ initial: restoreAchievementCheckpoint(clone(saved)), requiredConsumers: ["telemetry"], save: async checkpoint => { saved = clone(checkpoint); } });
    const observed = vi.fn(), handler = vi.fn(); second.subscribeCommitted(observed);
    await second.submit(afterA);
    expect(observed).not.toHaveBeenCalled();
    await second.drain("telemetry", handler);
    expect(handler).toHaveBeenCalledWith(receipt.deliveries[0]);
    expect(saved.pending).toEqual([]);
  });

  it("acknowledges two consumers independently and removes work only after both succeed", async () => {
    const value = port(undefined, ["telemetry", "reward"]); await value.submit(afterA);
    const id = value.committed.pending[0].id;
    expect(await value.drain("telemetry", () => {})).toEqual([id]);
    expect(value.committed.pending[0].acknowledgedBy).toEqual(["telemetry"]);
    const duplicate = vi.fn(); expect(await value.drain("telemetry", duplicate)).toEqual([]);
    expect(duplicate).not.toHaveBeenCalled();
    await expect(value.drain("reward", () => { throw new Error("reward unavailable"); })).rejects.toThrow();
    expect(value.committed.pending[0].acknowledgedBy).toEqual(["telemetry"]);
    await value.drain("reward", () => {});
    expect(value.committed.pending).toEqual([]);
  });

  it("retains original recipients across configuration changes and permits their historical handler", async () => {
    const original = port(undefined, ["telemetry", "old-reward"]); await original.submit(afterA);
    const value = createAchievementCommitPort({ initial: clone(original.committed), requiredConsumers: ["telemetry"], save: async () => {} });
    await value.submit(afterB);
    expect(value.committed.pending.map(item => item.requiredConsumers)).toEqual([["telemetry", "old-reward"], ["telemetry"]]);
    await value.drain("telemetry", () => {});
    expect(value.committed.pending).toHaveLength(1);
    await value.drain("old-reward", () => {});
    expect(value.committed.pending).toEqual([]);
    await expect(value.drain("never-registered", () => {})).rejects.toThrow(/未注册/);
  });

  it("rebases an acknowledgement on a newer submission instead of overwriting B", async () => {
    const value = port(); await value.submit(afterA);
    const entered = deferred(), release = deferred();
    const draining = value.drain("telemetry", async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    await value.submit(afterB);
    expect(value.committed.pending.map(item => item.key)).toEqual([alpha, beta]);
    release.resolve(); await draining;
    expect(value.committed.ledger).toEqual(afterB);
    expect(value.committed.pending.map(item => item.key)).toEqual([beta]);
  });

  it("allows a handler to await a nested submission without deadlocking the save queue", async () => {
    const value = port(); await value.submit(afterA);
    await value.drain("telemetry", async () => { await value.submit(afterB); });
    expect(value.committed.ledger).toEqual(afterB);
    expect(value.committed.pending.map(item => item.key)).toEqual([beta]);
  });

  it("serializes concurrent drains of one consumer and merges different consumers' acknowledgements", async () => {
    const value = port(undefined, ["telemetry", "reward"]); await value.submit(afterA);
    const a = vi.fn(), b = vi.fn(), reward = vi.fn();
    await Promise.all([value.drain("telemetry", a), value.drain("telemetry", b), value.drain("reward", reward)]);
    expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled(); expect(reward).toHaveBeenCalledTimes(1);
    expect(value.committed.pending).toEqual([]);
  });

  it("detaches candidates and exposes deeply immutable committed data and delivery receipts", async () => {
    const raw = clone(createAchievementCheckpoint(initial)), recipients = ["telemetry"];
    const value = new AchievementCommitPort({ initial: raw, requiredConsumers: recipients, save: async () => {} });
    recipients.push("unexpected");
    const candidate = clone(afterA), submitting = value.submit(candidate);
    (candidate.records[alpha].completed as { at: string }).at = "2026-11-10T03:00:00.000Z";
    const receipt = await submitting;
    expect(receipt.deliveries[0].completion.at).toBe("2026-11-10T01:00:00.000Z");
    expect(receipt.deliveries[0].requiredConsumers).toEqual(["telemetry"]);
    expect(Object.isFrozen(value.committed)).toBe(true);
    expect(Object.isFrozen(value.committed.ledger.records[alpha].tracking.tracks[0])).toBe(true);
    expect(Object.isFrozen(receipt.deliveries[0].acknowledgedBy)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
  });

  it("silently wraps legacy ledgers and evaluates reward requirements only against committed progress", async () => {
    const checkpoint = restoreAchievementCheckpoint(clone(afterA));
    expect(checkpoint).toEqual({ schemaVersion: 1, ledger: afterA, pending: [] });
    expect(restoreAchievementCheckpoint(clone(checkpoint))).toEqual(checkpoint);
    const value = createAchievementCommitPort({ initial: checkpoint, requiredConsumers: ["telemetry"], save: async () => {} });
    const observer = vi.fn(); value.subscribeCommitted(observer);
    expect(await value.submit(afterA)).toMatchObject({ deliveries: [], replayed: true });
    expect(observer).not.toHaveBeenCalled();
    const requirement = AchievementUnlockRequirementSchema.parse({ type: "achievement-unlocked", key: alpha });
    expect(isAchievementUnlocked(value.committed.ledger, alpha)).toBe(true);
    expect(meetsAchievementUnlockRequirement(value.committed.ledger, requirement)).toBe(true);
    expect(meetsAchievementUnlockRequirement(value.committed.ledger, { ...requirement, key: beta })).toBe(false);
    expect(AchievementUnlockRequirementSchema.safeParse({ type: "unlock-now", key: alpha }).success).toBe(false);
  });
});

describe("achievement checkpoint integrity", () => {
  it("validates stable identity, ledger membership and acknowledgement recipients", () => {
    const good = delivery(afterA, alpha);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterA, pending: [good] }).success).toBe(true);
    expect(AchievementUnlockDeliverySchema.safeParse({ ...good, id: "arbitrary-id" }).success).toBe(false);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: initial, pending: [good] }).success).toBe(false);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterA, pending: [good, good] }).success).toBe(false);
    expect(AchievementUnlockDeliverySchema.safeParse({ ...good, acknowledgedBy: ["stranger"] }).success).toBe(false);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterA, pending: [{ ...good, acknowledgedBy: ["telemetry"] }] }).success).toBe(false);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterA, pending: [{ ...good, allowDebug: true }] }).success).toBe(false);
  });

  it("bounds pending jobs, recipient counts and all retained historical consumer IDs", () => {
    const good = delivery(afterA, alpha);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterA, pending: Array.from({ length: 1025 }, () => good) }).success).toBe(false);
    expect(() => port(undefined, Array.from({ length: 17 }, (_, index) => `consumer-${index}`))).toThrow(/预算/);
    expect(() => port(undefined, [])).toThrow();
    expect(() => port(undefined, ["telemetry", "telemetry"])).toThrow();
    const result = AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: afterB, pending: [
      delivery(afterB, alpha, Array.from({ length: 16 }, (_, index) => `consumer-${index}`)), delivery(afterB, beta, ["one-more"])
    ] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("消费者总数超过预算");
  });

  it("rejects accessor payloads without executing them and rejects oversized sparse arrays", () => {
    let accessed = false;
    const raw = clone(createAchievementCheckpoint(initial));
    Object.defineProperty(raw, "pending", { enumerable: true, get() { accessed = true; return []; } });
    expect(AchievementCheckpointSchema.safeParse(raw).success).toBe(false);
    expect(accessed).toBe(false);
    expect(AchievementCheckpointSchema.safeParse({ schemaVersion: 1, ledger: initial, pending: Array(4097) }).success).toBe(false);
  });
});
