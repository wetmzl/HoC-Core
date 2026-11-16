import { z } from "zod";
import { BINARY_SCALAR_OPERATIONS, UNARY_SCALAR_OPERATIONS } from "../expressions/arithmetic";
import { COMPARISON_OPERATORS } from "../expressions/comparison";
import { SkillCardFilterSchema } from "../abilities/schema";
import { SKILL_TAGS } from "../skills/types";
import { HocpkgPortablePathSchema } from "../../content/packages/schema";
import type { AchievementNumber, AchievementValue, AchievementCondition, AchievementTracking, AchievementDefinition,
  AchievementCatalog, StandardAchievementDefinition, StandardAchievementCatalog, AchievementObservation, AchievementObservationContract, AchievementLedger } from "./types";

export const ACHIEVEMENT_LIMITS = Object.freeze({ depth: 24, nodes: 32_000, collection: 4096, definitions: 256, tracks: 32, records: 1024 });
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const name = z.string().min(1).max(160).refine(value => !forbidden.has(value), "不允许保留对象键");
const localId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(80).refine(value => !forbidden.has(value));
const finite = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const natural = z.number().int().nonnegative().safe();
const primitive = z.union([z.string().max(2048), finite, z.boolean(), z.null()]);
const topic = z.object({ type: name, apiVersion: z.number().int().positive().safe() }).strict();
const scope = z.enum(["run", "match", "round"]);

/** Runs before recursive Zod schemas, including cyclic JS objects supplied through the SDK. */
export function assertAchievementBudget(input: unknown): void {
  const stack = [{ value: input, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > ACHIEVEMENT_LIMITS.nodes || depth > ACHIEVEMENT_LIMITS.depth) throw new Error("成就数据超过节点或嵌套预算");
    if (typeof value === "string" && value.length > 8192) throw new Error("成就数据字符串过长");
    if (!value || typeof value !== "object") continue;
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("成就数据只接受普通 JSON 对象和数组");
    if (Array.isArray(value) && value.length > ACHIEVEMENT_LIMITS.collection) throw new Error("成就数据集合过大");
    let entries = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++entries > ACHIEVEMENT_LIMITS.collection) throw new Error("成就数据集合过大");
      if (forbidden.has(key)) throw new Error("成就数据含保留对象键");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error("成就数据不能包含访问器");
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
    if (Reflect.ownKeys(value).length !== entries + (array ? 1 : 0)) throw new Error("成就数据不能包含隐藏字段或符号键");
  }
}
function bounded<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess((input, ctx) => {
    try { assertAchievementBudget(input); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
    return input;
  }, schema) as z.ZodType<T>;
}

const numberNode: z.ZodType<AchievementNumber> = z.lazy(() => z.union([
  finite,
  z.object({ type: z.literal("constant"), value: finite }).strict(),
  z.object({ type: z.literal("observation"), key: name }).strict(),
  z.object({ type: z.literal("metric"), id: localId }).strict(),
  z.object({ type: z.literal("skill-card-count"), collection: name, filter: SkillCardFilterSchema.optional() }).strict(),
  z.object({ type: z.enum(BINARY_SCALAR_OPERATIONS), left: numberNode, right: numberNode }).strict(),
  z.object({ type: z.enum(UNARY_SCALAR_OPERATIONS), value: numberNode }).strict()
]));
const valueNode: z.ZodType<AchievementValue> = z.lazy(() => z.union([
  z.object({ type: z.literal("literal"), value: primitive }).strict(),
  z.object({ type: z.literal("numeric"), value: numberNode }).strict(),
  z.object({ type: z.literal("observation"), key: name }).strict()
]));
const conditionNode: z.ZodType<AchievementCondition> = z.lazy(() => z.union([
  z.object({ type: z.enum(["all", "any"]), conditions: z.array(conditionNode).min(1).max(32) }).strict(),
  z.object({ type: z.literal("not"), condition: conditionNode }).strict(),
  z.object({ type: z.literal("scalar-compare"), left: numberNode, operator: z.enum(COMPARISON_OPERATORS), right: numberNode }).strict(),
  z.object({ type: z.literal("value-compare"), left: valueNode, operator: z.enum(["eq", "neq"]), right: valueNode }).strict(),
  z.object({ type: z.literal("available"), key: name }).strict(),
  z.object({ type: z.literal("topic-is"), topic }).strict()
]));
export const AchievementNumberSchema = bounded(numberNode);
export const AchievementValueSchema = bounded(valueNode);
export const AchievementConditionSchema = bounded(conditionNode);

const aggregation = z.union([
  z.object({ type: z.literal("count") }).strict(),
  z.object({ type: z.enum(["sum", "max"]), value: numberNode }).strict(),
  z.object({ type: z.literal("distinct"), value: valueNode, limit: z.number().int().positive().max(4096) }).strict()
]);
const track = z.object({ id: localId, on: z.array(topic).min(1).max(64).optional(), when: conditionNode.optional(), progress: aggregation }).strict();
const literalThreshold = (input: AchievementNumber) => typeof input === "number" ? input : input.type === "constant" ? input.value : undefined;
/** Positive monotonic totals can safely retain progress across gaps in package activation. */
function cumulativeCompletion(condition: AchievementCondition): boolean {
  if (condition.type === "all" || condition.type === "any") return condition.conditions.every(cumulativeCompletion);
  return condition.type === "scalar-compare" && typeof condition.left === "object" && condition.left.type === "metric"
    && (condition.operator === "gte" || condition.operator === "gt") && (literalThreshold(condition.right) ?? -1) > 0;
}
export const AchievementTrackingSchema: z.ZodType<AchievementTracking> = bounded(z.object({
  scope: z.enum(["profile", "run", "match", "round"]),
  completion: z.enum(["immediate", "scope-end"]).default("immediate"),
  continuity: z.enum(["continuous", "cumulative"]).default("continuous"),
  allowDebug: z.boolean().default(false),
  tracks: z.array(track).max(ACHIEVEMENT_LIMITS.tracks),
  completeWhen: conditionNode,
  resetWhen: conditionNode.optional(), invalidateWhen: conditionNode.optional()
}).strict().superRefine((data, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of data.tracks.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: ["tracks", index, "id"], message: "统计 ID 重复" });
    ids.add(item.id);
    if (item.on && new Set(item.on.map(ref => `${ref.type}:${ref.apiVersion}`)).size !== item.on.length) ctx.addIssue({ code: "custom", path: ["tracks", index, "on"], message: "主题引用重复" });
    const pending: unknown[] = [item.progress, item.when];
    while (pending.length) {
      const node = pending.pop(); if (!node || typeof node !== "object") continue;
      if ((node as { type?: string }).type === "metric") ctx.addIssue({ code: "custom", path: ["tracks", index], message: "统计更新不能读取统计，所有轨道独立更新" });
      pending.push(...Object.values(node));
    }
  }
  const pending: unknown[] = [data.completeWhen, data.resetWhen, data.invalidateWhen];
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== "object") continue;
    if ((node as { type?: string }).type === "metric" && !ids.has((node as { id: string }).id)) ctx.addIssue({ code: "custom", message: "条件引用不存在的统计 ID" });
    pending.push(...Object.values(node));
  }
  if (data.scope === "profile" && (data.completion === "scope-end" || data.invalidateWhen)) ctx.addIssue({ code: "custom", message: "profile 没有结束边界，也不能永久作废" });
  if (data.continuity === "cumulative" && (data.scope !== "profile" || data.resetWhen || data.invalidateWhen || !data.tracks.length || !cumulativeCompletion(data.completeWhen))) ctx.addIssue({ code: "custom", message: "可续接累计仅用于 profile 的正向统计阈值，不能重置、作废或依赖否定条件" });
}));
export const AchievementDefinitionSchema: z.ZodType<AchievementDefinition> = bounded(z.object({
  id: localId, revision: z.number().int().positive().safe(), name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2048), category: z.string().trim().min(1).max(80).optional(),
  cover: HocpkgPortablePathSchema.optional(), icon: HocpkgPortablePathSchema.optional(), hidden: z.boolean().optional(),
  progressDisplay: z.object({ metric: localId, target: finite.positive() }).strict().optional(), tracking: AchievementTrackingSchema
}).strict().superRefine((data, ctx) => {
  if (!data.progressDisplay) return;
  const progress = data.tracking.tracks.find(track => track.id === data.progressDisplay!.metric)?.progress;
  if (!progress) ctx.addIssue({ code: "custom", path: ["progressDisplay", "metric"], message: "进度展示必须引用已声明统计" });
  if ((progress?.type === "count" || progress?.type === "distinct") && !Number.isSafeInteger(data.progressDisplay.target)) ctx.addIssue({ code: "custom", path: ["progressDisplay", "target"], message: "计次与去重进度目标必须是安全整数" });
  if (progress?.type === "distinct" && data.progressDisplay.target > progress.limit) ctx.addIssue({ code: "custom", path: ["progressDisplay", "target"], message: "展示目标不得超过去重容量" });
}));
export const AchievementCatalogSchema: z.ZodType<AchievementCatalog> = bounded(z.object({
  achievements: z.array(AchievementDefinitionSchema).min(1).max(ACHIEVEMENT_LIMITS.definitions)
}).strict().superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.achievements.forEach((definition, index) => {
    if (seen.has(definition.id)) ctx.addIssue({ code: "custom", path: ["achievements", index, "id"], message: "成就局部 ID 重复" });
    seen.add(definition.id);
  });
}));
/** New authoring is strict about covers without invalidating previously delivered API 1 content. */
export const StandardAchievementDefinitionSchema: z.ZodType<StandardAchievementDefinition> = AchievementDefinitionSchema.transform((definition, ctx) => {
  if (!definition.cover) {
    ctx.addIssue({ code: "custom", path: ["cover"], message: "标准成就必须声明封面" });
    return z.NEVER;
  }
  return { ...definition, cover: definition.cover };
});
export const StandardAchievementCatalogSchema: z.ZodType<StandardAchievementCatalog> = AchievementCatalogSchema.transform((catalog, ctx) => {
  const achievements: StandardAchievementDefinition[] = [];
  catalog.achievements.forEach((definition, index) => {
    if (!definition.cover) ctx.addIssue({ code: "custom", path: ["achievements", index, "cover"], message: "标准成就必须声明封面" });
    else achievements.push({ ...definition, cover: definition.cover });
  });
  return { achievements };
});
export const AchievementKeySchema = z.string().max(400).regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*#[a-z0-9][a-z0-9:_-]*\/[a-z0-9][a-z0-9_-]*$/);
export const AchievementObservationContractSchema: z.ZodType<AchievementObservationContract> = bounded(z.object({
  topic, values: z.record(name, z.union([
    z.enum(["string", "number", "boolean", "null"]),
    z.array(z.enum(["string", "number", "boolean", "null"])).min(1).max(4).refine(types => new Set(types).size === types.length, "观察值类型不能重复")
  ])), skillCollections: z.array(name).max(64)
}).strict().superRefine((data, ctx) => {
  if (new Set(data.skillCollections).size !== data.skillCollections.length) ctx.addIssue({ code: "custom", message: "技能集合声明重复" });
}));
const skill = z.object({
  instanceId: name, definitionId: name, primaryDomain: z.enum(SKILL_TAGS),
  skillTags: z.array(z.enum(SKILL_TAGS)).min(1), tags: z.array(name), activation: z.enum(["action", "passive", "automatic"])
}).strict();
const boundary = z.union([
  z.object({ scope, phase: z.literal("begin") }).strict(),
  z.object({ scope, phase: z.literal("end"), reason: z.enum(["completed", "abandoned", "aborted"]) }).strict()
]);
export const AchievementObservationSchema: z.ZodType<AchievementObservation> = bounded(z.object({
  apiVersion: z.literal(1), streamId: name, sequence: natural, at: z.string().datetime({ offset: true }), topic,
  scopes: z.object({ run: name.optional(), match: name.optional(), round: name.optional() }).strict(),
  boundary: boundary.optional(), debugUsed: z.boolean(), values: z.record(name, primitive),
  skillCards: z.record(name, z.array(skill).max(4096).refine(cards => new Set(cards.map(card => card.instanceId)).size === cards.length, "同一技能集合不能重复实例"))
}).strict().superRefine((data, ctx) => {
  if (data.boundary && !data.scopes[data.boundary.scope]) ctx.addIssue({ code: "custom", message: "边界必须携带对应窗口 ID" });
}));
const metric = z.union([
  z.object({ type: z.literal("count"), value: natural }).strict(),
  z.object({ type: z.literal("sum"), value: finite.nonnegative() }).strict(),
  z.object({ type: z.literal("max"), value: finite.nonnegative().nullable() }).strict(),
  z.object({ type: z.literal("distinct"), values: z.array(primitive).max(4096) }).strict()
]);
const window = z.object({ id: name, status: z.enum(["active", "completed", "abandoned", "aborted"]) }).strict();
const record = z.object({
  revision: z.number().int().positive().safe(), tracking: AchievementTrackingSchema, scopeId: name,
  metrics: z.record(localId, metric), invalidated: z.boolean(), suspended: z.boolean(),
  completed: z.object({ at: z.string().datetime({ offset: true }), sequence: natural, revision: z.number().int().positive().safe() }).strict().optional()
}).strict().superRefine((data, ctx) => {
  const expected = new Map(data.tracking.tracks.map(track => [track.id, track.progress]));
  if (Object.keys(data.metrics).length !== expected.size) ctx.addIssue({ code: "custom", message: "账本统计集合与规则不符" });
  for (const [id, state] of Object.entries(data.metrics)) {
    const progress = expected.get(id);
    if (!progress || progress.type !== state.type) ctx.addIssue({ code: "custom", message: "账本统计类型与规则不符" });
    if (state.type === "distinct" && (new Set(state.values.map(v => JSON.stringify(v))).size !== state.values.length || progress?.type === "distinct" && state.values.length > progress.limit)) ctx.addIssue({ code: "custom", message: "去重统计重复或超过上限" });
  }
  if (data.completed && data.completed.revision !== data.revision) ctx.addIssue({ code: "custom", message: "完成修订与账本规则不符" });
});
export const AchievementLedgerSchema: z.ZodType<AchievementLedger> = bounded(z.object({
  schemaVersion: z.literal(1), streamId: name, nextSequence: natural,
  windows: z.object({ run: window.optional(), match: window.optional(), round: window.optional() }).strict(),
  records: z.record(AchievementKeySchema, record).refine(records => Object.keys(records).length <= ACHIEVEMENT_LIMITS.records, "成就账本条目过多")
}).strict().superRefine((data, ctx) => {
  for (const item of Object.values(data.records)) {
    if (item.completed && item.completed.sequence >= data.nextSequence) ctx.addIssue({ code: "custom", message: "完成证据超出已消费游标" });
    if (item.tracking.scope === "profile" && item.scopeId !== data.streamId) ctx.addIssue({ code: "custom", message: "profile 统计必须归属本持久流" });
  }
}));
