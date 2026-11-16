import { z } from "zod";
import { AchievementKeySchema, AchievementLedgerSchema, assertAchievementBudget } from "./schema";
import type { AchievementCompletion, AchievementLedger, AchievementRecord } from "./types";

export const ACHIEVEMENT_CHECKPOINT_VERSION = 1 as const;
export const ACHIEVEMENT_COMMIT_LIMITS = Object.freeze({ pending: 1024, consumers: 16 });

export interface AchievementUnlockDelivery {
  readonly id: string;
  readonly key: string;
  readonly completion: AchievementCompletion;
  readonly allowDebug: boolean;
  /** Each durable delivery retains its original recipients across configuration changes. */
  readonly requiredConsumers: readonly string[];
  readonly acknowledgedBy: readonly string[];
}

/** A new storage envelope; the independently versioned Ledger 1 stays unchanged. */
export interface AchievementCheckpoint {
  readonly schemaVersion: typeof ACHIEVEMENT_CHECKPOINT_VERSION;
  readonly ledger: AchievementLedger;
  readonly pending: readonly AchievementUnlockDelivery[];
}

export interface AchievementCommitReceipt {
  readonly before: AchievementLedger;
  readonly after: AchievementLedger;
  readonly deliveries: readonly AchievementUnlockDelivery[];
  readonly replayed: boolean;
}

export interface AchievementUnlockRequirement {
  readonly type: "achievement-unlocked";
  readonly key: string;
}

function bounded<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess((input, context) => {
    try { assertAchievementBudget(input); }
    catch (error) { context.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
    return input;
  }, schema) as z.ZodType<T>;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const streamId = z.string().min(1).max(160).refine(value => !forbidden.has(value));
const consumerId = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:/#-]*$/).refine(value => !forbidden.has(value));
const consumerList = z.array(consumerId).max(ACHIEVEMENT_COMMIT_LIMITS.consumers)
  .refine(values => new Set(values).size === values.length, "成就消费者 ID 重复");
const completion = z.object({ at: z.string().datetime({ offset: true }), sequence: z.number().int().nonnegative().safe(), revision: z.number().int().positive().safe() }).strict();
const deliveryIdentity = z.tuple([z.literal("achievement-unlocked"), streamId, AchievementKeySchema, z.number().int().nonnegative().safe(), z.number().int().positive().safe()]);

/** Stable, unambiguous identity; timestamps and mutable presentation metadata are excluded. */
export function createAchievementUnlockDeliveryId(stream: string, key: string, evidence: AchievementCompletion): string {
  assertAchievementBudget(evidence);
  const valid = completion.parse(evidence);
  return JSON.stringify(deliveryIdentity.parse(["achievement-unlocked", stream, key, valid.sequence, valid.revision]));
}

function readDeliveryId(id: string): z.infer<typeof deliveryIdentity> | undefined {
  try {
    const parts = deliveryIdentity.parse(JSON.parse(id));
    return JSON.stringify(parts) === id ? parts : undefined;
  } catch { return undefined; }
}

export const AchievementUnlockDeliverySchema: z.ZodType<AchievementUnlockDelivery> = bounded(z.object({
  id: z.string().min(1).max(2048), key: AchievementKeySchema, completion, allowDebug: z.boolean(),
  requiredConsumers: consumerList.min(1), acknowledgedBy: consumerList
}).strict().superRefine((delivery, context) => {
  const identity = readDeliveryId(delivery.id);
  if (!identity || identity[2] !== delivery.key || identity[3] !== delivery.completion.sequence || identity[4] !== delivery.completion.revision)
    context.addIssue({ code: "custom", path: ["id"], message: "成就投递 ID 与完成证据不符" });
  if (delivery.acknowledgedBy.some(id => !delivery.requiredConsumers.includes(id)))
    context.addIssue({ code: "custom", path: ["acknowledgedBy"], message: "成就确认包含未要求的消费者" });
}));

export const AchievementCheckpointSchema: z.ZodType<AchievementCheckpoint> = bounded(z.object({
  schemaVersion: z.literal(ACHIEVEMENT_CHECKPOINT_VERSION), ledger: AchievementLedgerSchema,
  pending: z.array(AchievementUnlockDeliverySchema).max(ACHIEVEMENT_COMMIT_LIMITS.pending)
}).strict().superRefine((checkpoint, context) => {
  const ids = new Set<string>(), keys = new Set<string>(), consumers = new Set<string>();
  for (const [index, delivery] of checkpoint.pending.entries()) {
    const record = checkpoint.ledger.records[delivery.key];
    if (ids.has(delivery.id) || keys.has(delivery.key)) context.addIssue({ code: "custom", path: ["pending", index], message: "成就待投递记录重复" });
    ids.add(delivery.id); keys.add(delivery.key);
    delivery.requiredConsumers.forEach(id => consumers.add(id));
    if (!record?.completed || canonical(record.completed) !== canonical(delivery.completion) || record.tracking.allowDebug !== delivery.allowDebug
      || createAchievementUnlockDeliveryId(checkpoint.ledger.streamId, delivery.key, delivery.completion) !== delivery.id)
      context.addIssue({ code: "custom", path: ["pending", index], message: "成就待投递记录不属于本已完成账本" });
    if (delivery.requiredConsumers.every(id => delivery.acknowledgedBy.includes(id)))
      context.addIssue({ code: "custom", path: ["pending", index], message: "全部确认的成就不得继续占用待投递队列" });
  }
  if (consumers.size > ACHIEVEMENT_COMMIT_LIMITS.consumers) context.addIssue({ code: "custom", path: ["pending"], message: "成就待投递消费者总数超过预算" });
}));

export const AchievementUnlockRequirementSchema: z.ZodType<AchievementUnlockRequirement> = bounded(z.object({
  type: z.literal("achievement-unlocked"), key: AchievementKeySchema
}).strict());

/** Convert a pre-existing Ledger 1 silently; restored completions are not new deliveries. */
export function createAchievementCheckpoint(ledger: AchievementLedger): AchievementCheckpoint {
  return freeze(AchievementCheckpointSchema.parse({ schemaVersion: ACHIEVEMENT_CHECKPOINT_VERSION, ledger, pending: [] }));
}

/** Initialization only. Preserve an outbox checkpoint or silently wrap a legacy standalone ledger. */
export function restoreAchievementCheckpoint(input: unknown): AchievementCheckpoint {
  assertAchievementBudget(input);
  if (input && typeof input === "object" && Object.hasOwn(input, "ledger")) return freeze(AchievementCheckpointSchema.parse(input));
  return createAchievementCheckpoint(AchievementLedgerSchema.parse(input));
}

export function isAchievementUnlocked(ledger: AchievementLedger, key: string): boolean {
  const valid = AchievementLedgerSchema.parse(ledger), identity = AchievementKeySchema.parse(key);
  return Object.hasOwn(valid.records, identity) && Boolean(valid.records[identity].completed);
}

export function meetsAchievementUnlockRequirement(ledger: AchievementLedger, requirement: AchievementUnlockRequirement): boolean {
  const valid = AchievementUnlockRequirementSchema.parse(requirement);
  return isAchievementUnlocked(ledger, valid.key);
}

export interface AchievementCommitPortOptions {
  readonly initial: AchievementCheckpoint | AchievementLedger;
  /** Applies to newly committed deliveries, never rewrites a restored delivery's recipients. */
  readonly requiredConsumers: readonly string[];
  /** Must atomically persist the complete envelope before resolving. */
  readonly save: (checkpoint: AchievementCheckpoint) => Promise<void>;
  readonly onObserverError?: (error: unknown) => void;
}

type CommitObserver = (receipt: AchievementCommitReceipt) => void | Promise<void>;

function completedRecord(record: AchievementRecord): string {
  const { suspended: _suspended, ...permanent } = record;
  return canonical(permanent);
}

/** Pure checkpoint projection, suitable for a transaction that also owns gameplay state. */
export function projectAchievementCheckpoint(
  checkpoint: AchievementCheckpoint, afterLedger: AchievementLedger, requiredConsumers: readonly string[], expectedBefore?: AchievementLedger
): { readonly checkpoint: AchievementCheckpoint; readonly receipt: AchievementCommitReceipt } {
  const initial = restoreAchievementCheckpoint(checkpoint);
  const requested = freeze(AchievementLedgerSchema.parse(afterLedger));
  const expected = expectedBefore === undefined ? undefined : freeze(AchievementLedgerSchema.parse(expectedBefore));
  const consumers = consumerList.min(1).parse(requiredConsumers);
  const before = initial.ledger;
  if (requested.streamId !== before.streamId) throw new Error("成就提交不属于本持久流");
  if (expected && canonical(expected) !== canonical(before)) throw new Error("成就提交耐久基线已改变");
  if (requested.nextSequence < before.nextSequence) throw new Error("成就提交消费位置不得倒退");
  if (requested.nextSequence === before.nextSequence) {
    if (canonical(requested) !== canonical(before)) throw new Error("相同消费位置不能改写成就账本");
    return freeze({ checkpoint: initial, receipt: { before, after: before, deliveries: [], replayed: true } });
  }
  for (const [key, record] of Object.entries(before.records)) {
    if (record.completed && (!requested.records[key]?.completed || completedRecord(requested.records[key]) !== completedRecord(record)))
      throw new Error("已完成成就及其规则证据不得删除或修改");
  }
  const deliveries: AchievementUnlockDelivery[] = [];
  for (const [key, record] of Object.entries(requested.records)) {
    if (!record.completed || before.records[key]?.completed) continue;
    if (record.completed.sequence < before.nextSequence || record.completed.sequence >= requested.nextSequence || record.invalidated)
      throw new Error("新成就完成证据不在本次新增消费范围内");
    deliveries.push({ id: createAchievementUnlockDeliveryId(before.streamId, key, record.completed), key,
      completion: record.completed, allowDebug: record.tracking.allowDebug,
      requiredConsumers: [...consumers], acknowledgedBy: [] });
  }
  if (initial.pending.length + deliveries.length > ACHIEVEMENT_COMMIT_LIMITS.pending) throw new Error("成就待投递队列已满");
  const next = freeze(AchievementCheckpointSchema.parse({ schemaVersion: ACHIEVEMENT_CHECKPOINT_VERSION,
    ledger: requested, pending: [...initial.pending, ...deliveries] }));
  return freeze({ checkpoint: next, receipt: { before, after: next.ledger, deliveries, replayed: false } });
}

/** Owns a durable baseline and outbox; it does not evaluate rules or run game scope producers. */
export class AchievementCommitPort {
  private checkpoint: AchievementCheckpoint;
  private queue: Promise<void> = Promise.resolve();
  private readonly consumers: readonly string[];
  private readonly observers = new Set<CommitObserver>();
  private readonly consumerQueues = new Map<string, Promise<readonly string[]>>();

  constructor(private readonly options: AchievementCommitPortOptions) {
    this.checkpoint = restoreAchievementCheckpoint(options.initial);
    assertAchievementBudget(options.requiredConsumers);
    if (options.requiredConsumers.length > ACHIEVEMENT_COMMIT_LIMITS.consumers) throw new Error("成就消费者数量超过预算");
    this.consumers = freeze(consumerList.min(1).parse(options.requiredConsumers));
  }

  get committed(): AchievementCheckpoint { return this.checkpoint; }

  isAchievementUnlocked(key: string): boolean {
    const valid = AchievementKeySchema.parse(key);
    return Object.hasOwn(this.checkpoint.ledger.records, valid) && Boolean(this.checkpoint.ledger.records[valid].completed);
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(next: AchievementCheckpoint): Promise<void> {
    const valid = freeze(AchievementCheckpointSchema.parse(next));
    await this.options.save(valid);
    this.checkpoint = valid;
  }

  /** Detached before queueing: callers cannot modify a candidate while another write is pending. */
  async submit(afterLedger: AchievementLedger, expectedBefore?: AchievementLedger): Promise<AchievementCommitReceipt> {
    const requested = freeze(AchievementLedgerSchema.parse(afterLedger));
    const expected = expectedBefore === undefined ? undefined : freeze(AchievementLedgerSchema.parse(expectedBefore));
    return this.enqueue(async () => {
      const projection = projectAchievementCheckpoint(this.checkpoint, requested, this.consumers, expected);
      if (projection.receipt.replayed) return projection.receipt;
      await this.persist(projection.checkpoint);
      const receipt = freeze({ ...projection.receipt, after: this.checkpoint.ledger });
      const deliveries = receipt.deliveries;
      if (deliveries.length) this.notify(receipt);
      return receipt;
    });
  }

  /** Best-effort presentation observers are distinct from durable drain consumers. */
  subscribeCommitted(observer: CommitObserver, options: { readonly signal?: AbortSignal } = {}): () => void {
    if (options.signal?.aborted) return () => {};
    this.observers.add(observer);
    const release = () => { this.observers.delete(observer); options.signal?.removeEventListener("abort", release); };
    options.signal?.addEventListener("abort", release, { once: true });
    return release;
  }

  private notify(receipt: AchievementCommitReceipt): void {
    const report = (error: unknown) => { try { this.options.onObserverError?.(error); } catch { /* Diagnostics never roll back a committed unlock. */ } };
    for (const observer of [...this.observers]) {
      if (!this.observers.has(observer)) continue;
      try {
        const result = observer(receipt);
        if (result) void Promise.resolve(result).catch(report);
      } catch (error) { report(error); }
    }
  }

  /**
   * A handler must be idempotent by delivery.id: successful work can repeat if saving its ack fails.
   * Checkpoint updates are serialized, while handlers run outside that queue to permit nested submits.
   */
  async drain(id: string, handler: (delivery: AchievementUnlockDelivery) => void | Promise<void>): Promise<readonly string[]> {
    const consumer = consumerId.parse(id);
    // Do not accumulate queues for arbitrary caller-supplied identities before validation runs.
    if (!this.recognizesConsumer(consumer)) throw new Error("未注册的成就投递消费者");
    const previous = this.consumerQueues.get(consumer) ?? Promise.resolve([]);
    const operation = previous.catch(() => []).then(() => this.drainBatch(consumer, handler));
    this.consumerQueues.set(consumer, operation);
    try { return await operation; }
    finally { if (this.consumerQueues.get(consumer) === operation) this.consumerQueues.delete(consumer); }
  }

  private recognizesConsumer(consumer: string): boolean {
    return this.consumers.includes(consumer) || this.checkpoint.pending.some(delivery => delivery.requiredConsumers.includes(consumer));
  }

  private async drainBatch(consumer: string, handler: (delivery: AchievementUnlockDelivery) => void | Promise<void>): Promise<readonly string[]> {
    const jobs = await this.enqueue(() => {
      if (!this.recognizesConsumer(consumer)) throw new Error("未注册的成就投递消费者");
      return this.checkpoint.pending.filter(delivery => delivery.requiredConsumers.includes(consumer) && !delivery.acknowledgedBy.includes(consumer));
    });
    const acknowledged: string[] = [];
    for (const job of jobs) {
      await handler(job);
      await this.enqueue(async () => {
        const pending = this.checkpoint.pending.map(delivery => delivery.id === job.id
          ? { ...delivery, acknowledgedBy: [...delivery.acknowledgedBy, consumer] } : delivery)
          .filter(delivery => !delivery.requiredConsumers.every(id => delivery.acknowledgedBy.includes(id)));
        await this.persist({ ...this.checkpoint, pending });
        acknowledged.push(job.id);
      });
    }
    return freeze(acknowledged);
  }
}

export function createAchievementCommitPort(options: AchievementCommitPortOptions): AchievementCommitPort {
  return new AchievementCommitPort(options);
}
