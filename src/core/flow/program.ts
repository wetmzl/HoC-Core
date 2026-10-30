import { z } from "zod";
import type { PlayerSkillCarryover } from "../abilities/carryover";
import type { MatchState } from "../match/types";
import { FlowDefinitionSchema } from "./schema";
import { MatchInitSpecSchema } from "./initialization";
import { AbilityBindingSchema } from "../abilities/schema";

const id = z.string().min(1);
const integer = z.number().int().safe();
export const ProgramScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type ProgramScalar = z.infer<typeof ProgramScalarSchema>;
export const ProgramGunSchema = z.object({ capacity: integer.positive(), bullets: integer.nonnegative() }).strict()
  .refine(value => value.bullets <= value.capacity, "装填不能超过容量");
export type ProgramCondition =
  | { type: "always" }
  | { type: "all" | "any"; conditions: ProgramCondition[] }
  | { type: "not"; condition: ProgramCondition }
  | { type: "completed"; nodeId: string }
  | { type: "visit-count"; nodeId: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: number }
  | { type: "result"; source?: string; outcome: "victory" | "defeat" | "escaped" }
  | { type: "variable"; key: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: ProgramScalar }
  | { type: "resource"; resource: "bullets" | "gunCapacity" | "skillDraws" | "comparisonBonus"; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: number }
  | { type: "fact"; fact: "defeated" | "completed-flow"; id: string };
const comparison = z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]);
const resource = z.enum(["bullets", "gunCapacity", "skillDraws", "comparisonBonus"]);
export const ProgramConditionSchema: z.ZodType<ProgramCondition> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }).strict(),
  z.object({ type: z.literal("all"), conditions: z.array(ProgramConditionSchema) }).strict(),
  z.object({ type: z.literal("any"), conditions: z.array(ProgramConditionSchema) }).strict(),
  z.object({ type: z.literal("not"), condition: ProgramConditionSchema }).strict(),
  z.object({ type: z.literal("completed"), nodeId: id }).strict(),
  z.object({ type: z.literal("visit-count"), nodeId: id, operator: comparison, value: integer.nonnegative() }).strict(),
  z.object({ type: z.literal("result"), source: id.optional(), outcome: z.enum(["victory", "defeat", "escaped"]) }).strict(),
  z.object({ type: z.literal("variable"), key: id, operator: comparison, value: ProgramScalarSchema }).strict(),
  z.object({ type: z.literal("resource"), resource, operator: comparison, value: z.number().finite() }).strict(),
  z.object({ type: z.literal("fact"), fact: z.enum(["defeated", "completed-flow"]), id }).strict()
]));
export const ProgramTransitionSchema = z.union([id, z.object({
  branches: z.array(z.object({ when: ProgramConditionSchema, to: id }).strict()), otherwise: id
}).strict()]);
const effectBase = { id, when: ProgramConditionSchema.optional() };
export const ProgramEffectSchema = z.discriminatedUnion("type", [
  z.object({ ...effectBase, type: z.literal("set-variable"), key: id, value: ProgramScalarSchema }).strict(),
  z.object({ ...effectBase, type: z.literal("add-variable"), key: id, value: integer }).strict(),
  z.object({ ...effectBase, type: z.literal("resource"), resource, operation: z.enum(["set", "add"]), value: integer, clamp: z.boolean().optional() }).strict(),
  z.object({ ...effectBase, type: z.literal("grant-skill"), binding: AbilityBindingSchema }).strict(),
  z.object({ ...effectBase, type: z.literal("record-result"), source: id.optional() }).strict(),
  z.object({ ...effectBase, type: z.literal("complete-flow"), flowId: id.optional(), legacyChallengeId: id.optional() }).strict()
]);
export const ProgramRewardSchema = z.object({ id, label: id, when: ProgramConditionSchema.optional(), effects: z.array(ProgramEffectSchema).min(1) }).strict();
export const ProgramPresentationSchema = FlowDefinitionSchema.shape.presentation.unwrap();
const nodePresentation = FlowDefinitionSchema.shape.nodes.element.shape.presentation;
const nodeAbilities = FlowDefinitionSchema.shape.nodes.element.shape.abilities;
const base = { id, title: id.optional() };
export const ProgramNodeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("initialize"), resources: z.object({ gun: ProgramGunSchema.optional(), player: z.enum(["clear", "preserve"]).optional(), comparisonBonus: integer.optional() }).strict().optional(), variables: z.record(id, ProgramScalarSchema).optional(), next: ProgramTransitionSchema }).strict(),
  z.object({ ...base, type: z.literal("match"), opponentId: id, init: MatchInitSpecSchema.optional(), abilities: nodeAbilities, presentation: nodePresentation, escapePresentation: z.enum(["immediate", "summary"]).optional(),
    routes: z.object({ victory: ProgramTransitionSchema, defeat: ProgramTransitionSchema, escaped: ProgramTransitionSchema }).strict() }).strict(),
  z.object({ ...base, type: z.literal("choice"), description: z.string().optional(), options: z.array(z.object({ id, label: id.optional(), characterId: id.optional(), to: id, when: ProgramConditionSchema.optional(), presentation: nodePresentation }).strict()).min(1) }).strict(),
  z.object({ ...base, type: z.literal("effect"), effects: z.array(ProgramEffectSchema), next: ProgramTransitionSchema }).strict(),
  z.object({ ...base, type: z.literal("settlement"), source: id.optional(), rewards: z.array(ProgramRewardSchema).default([]), effects: z.array(ProgramEffectSchema).default([]), confirmation: z.enum(["required", "automatic"]).default("required"), continueLabel: id.optional(), next: ProgramTransitionSchema }).strict(),
  z.object({ ...base, type: z.literal("presentation"), body: z.string(), actionLabel: id.optional(), next: ProgramTransitionSchema }).strict(),
  z.object({ ...base, type: z.literal("end"), result: z.enum(["victory", "defeat", "abandoned"]), effects: z.array(ProgramEffectSchema).default([]) }).strict()
]);
export type ProgramNode = z.infer<typeof ProgramNodeSchema>;
export type ProgramEffect = z.infer<typeof ProgramEffectSchema>;
export type ProgramReward = z.infer<typeof ProgramRewardSchema>;
export type ProgramTransition = z.infer<typeof ProgramTransitionSchema>;

function conditionReferences(condition: ProgramCondition): string[] {
  if (condition.type === "completed" || condition.type === "visit-count") return [condition.nodeId];
  if (condition.type === "result") return condition.source && condition.source !== "latest" ? [condition.source] : [];
  if (condition.type === "all" || condition.type === "any") return condition.conditions.flatMap(conditionReferences);
  return condition.type === "not" ? conditionReferences(condition.condition) : [];
}
export function transitionTargets(transition: ProgramTransition): string[] {
  return typeof transition === "string" ? [transition] : [...transition.branches.flatMap(branch => [branch.to, ...conditionReferences(branch.when)]), transition.otherwise];
}
export const ProgramDefinitionSchema = z.object({
  version: z.literal(2), id, start: id, defaults: MatchInitSpecSchema.optional(),
  presentation: ProgramPresentationSchema.optional(), nodes: z.array(ProgramNodeSchema).min(1),
  /** Read-only compatibility projection; execution never consults it. */
  legacyDefinition: FlowDefinitionSchema.optional()
}).strict().superRefine((definition, ctx) => {
  const ids = new Set(definition.nodes.map(node => node.id));
  if (ids.size !== definition.nodes.length) ctx.addIssue({ code: "custom", message: "流程节点 ID 重复" });
  if (!ids.has(definition.start)) ctx.addIssue({ code: "custom", message: "入口节点不存在" });
  for (const node of definition.nodes) {
    const refs = node.type === "match" ? Object.values(node.routes).flatMap(transitionTargets)
      : node.type === "choice" ? node.options.flatMap(option => [option.to, ...(option.when ? conditionReferences(option.when) : [])])
      : node.type === "end" ? [] : transitionTargets(node.next);
    if (node.type === "match") refs.push(...(node.abilities ?? []).flatMap(slot => slot.overrides.flatMap(override => override.afterAny)));
    if (node.type === "settlement" && node.source && node.source !== "latest") refs.push(node.source);
    const effectGroups = node.type === "effect" || node.type === "end" ? [node.effects]
      : node.type === "settlement" ? [node.effects, ...node.rewards.map(reward => reward.effects)] : [];
    for (const effects of effectGroups) {
      if (new Set(effects.map(effect => effect.id)).size !== effects.length) ctx.addIssue({ code: "custom", message: "同组效果 ID 重复" });
      for (const effect of effects) {
        if (effect.when) refs.push(...conditionReferences(effect.when));
        if (effect.type === "record-result" && effect.source && effect.source !== "latest") refs.push(effect.source);
      }
    }
    if (node.type === "choice" && new Set(node.options.map(option => option.id)).size !== node.options.length) ctx.addIssue({ code: "custom", message: "选项 ID 重复" });
    if (node.type === "settlement") {
      if (new Set(node.rewards.map(reward => reward.id)).size !== node.rewards.length) ctx.addIssue({ code: "custom", message: "奖励 ID 重复" });
      for (const reward of node.rewards) if (reward.when) refs.push(...conditionReferences(reward.when));
    }
    if (refs.some(reference => !ids.has(reference))) ctx.addIssue({ code: "custom", message: `节点 ${node.id} 引用了不存在的节点` });
  }
});
export type ProgramDefinition = z.infer<typeof ProgramDefinitionSchema>;
export interface ProgramResources { readonly gun: { capacity: number; bullets: number }; readonly player: PlayerSkillCarryover | null; readonly comparisonBonus: number; }
export interface ProgramResult { readonly id: string; readonly nodeId: string; readonly visitIndex: number; readonly outcome: "victory" | "defeat" | "escaped"; readonly match: MatchState; }
export type ProgramWrite = { readonly type: "record-result"; readonly resultId: string } | { readonly type: "complete-flow"; readonly flowId: string; readonly legacyChallengeId?: string };
export interface ProgramRun {
  readonly id: string; readonly seed: string; readonly definition: ProgramDefinition;
  readonly cursor: string; readonly visitIndex: number; readonly status: "waiting" | "match" | "finished";
  readonly completed: readonly string[]; readonly variables: Readonly<Record<string, ProgramScalar>>;
  readonly visits: Readonly<Record<string, number>>;
  readonly resources: ProgramResources | null; readonly results: readonly ProgramResult[];
  readonly claimed: readonly string[]; readonly pendingWrites: readonly ProgramWrite[];
  readonly result: "victory" | "defeat" | "abandoned" | null;
}
/** Nested game snapshots receive their full engine validation at the persistence boundary. */
export const ProgramRunSchema = z.object({
  id, seed: id, definition: ProgramDefinitionSchema, cursor: id, visitIndex: integer.positive(), status: z.enum(["waiting", "match", "finished"]),
  completed: z.array(id), variables: z.record(id, ProgramScalarSchema), visits: z.record(id, integer.nonnegative()),
  resources: z.object({ gun: ProgramGunSchema, player: z.custom<PlayerSkillCarryover>(value => !!value && typeof value === "object").nullable(), comparisonBonus: integer }).strict().nullable(),
  results: z.array(z.object({ id, nodeId: id, visitIndex: integer.positive(), outcome: z.enum(["victory", "defeat", "escaped"]), match: z.custom<MatchState>(value => !!value && typeof value === "object") }).strict()),
  claimed: z.array(id), pendingWrites: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("record-result"), resultId: id }).strict(),
    z.object({ type: z.literal("complete-flow"), flowId: id, legacyChallengeId: id.optional() }).strict()
  ])), result: z.enum(["victory", "defeat", "abandoned"]).nullable()
}).strict().superRefine((run, ctx) => {
  const node = run.definition.nodes.find(node => node.id === run.cursor);
  if (!node || (run.status === "match" && node.type !== "match") || (run.status === "finished") !== (run.result !== null)
    || (run.status === "finished" && (node.type !== "end" || node.result !== run.result))) ctx.addIssue({ code: "custom", message: "流程节点和运行状态不一致" });
  if (!run.resources && run.status !== "match") ctx.addIssue({ code: "custom", message: "非牌局节点缺少流程资源" });
  if (new Set(run.completed).size !== run.completed.length || run.completed.some(id => !run.definition.nodes.some(node => node.id === id))) ctx.addIssue({ code: "custom", message: "完成节点无效" });
  if (new Set(run.claimed).size !== run.claimed.length || new Set(run.results.map(result => result.id)).size !== run.results.length) ctx.addIssue({ code: "custom", message: "流程收据重复" });
  if (run.results.some(result => !run.definition.nodes.some(node => node.id === result.nodeId && node.type === "match") || result.visitIndex >= run.visitIndex
    || result.id !== `${run.id}:visit:${result.visitIndex}` || result.match.id !== result.id)) ctx.addIssue({ code: "custom", message: "牌局结果来源无效" });
  if (new Set(run.results.map(result => result.visitIndex)).size !== run.results.length) ctx.addIssue({ code: "custom", message: "同次节点访问存在多个牌局结果" });
  if (run.results.some(result => {
    const outcome = result.match.outcome;
    return !outcome || result.outcome !== (outcome.reason === "escaped" ? "escaped" : outcome.winner === "player" && outcome.reason === "opponent-killed" ? "victory" : "defeat");
  })) ctx.addIssue({ code: "custom", message: "流程结果与牌局结果不一致" });
  if (Object.keys(run.visits).some(id => !run.definition.nodes.some(node => node.id === id)) || !run.visits[run.cursor]
    || Object.values(run.visits).reduce((sum, value) => sum + value, 0) !== run.visitIndex) ctx.addIssue({ code: "custom", message: "流程访问计数无效" });
  if (run.pendingWrites.some(write => write.type === "record-result" && !run.results.some(result => result.id === write.resultId))) ctx.addIssue({ code: "custom", message: "记账意图缺少结果收据" });
});
export interface ProgramFacts { readonly defeated?: readonly string[]; readonly completedFlows?: readonly string[]; }
