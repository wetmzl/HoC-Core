import { z } from "zod";
import { AbilityBindingSchema } from "../abilities/schema";
import type { GunState } from "../roulette/types";

const id = z.string().min(1);
const amount = z.number().int().positive().safe();
export const EncounterRewardsSchema = z.object({
  skillDraws: amount.optional(), removeBullets: amount.optional(), pointAdvantage: amount.optional()
}).strict().refine(value => Object.values(value).some(amount => amount !== undefined), "胜利奖励不能为空");
export const EncounterRewardKindSchema = z.enum(["skillDraws", "removeBullets", "pointAdvantage"]);
export type EncounterRewards = z.infer<typeof EncounterRewardsSchema>;
export type EncounterRewardKind = z.infer<typeof EncounterRewardKindSchema>;
export const FlowResultSchema = z.enum(["victory", "defeat", "abandoned"]);
const GunSchema = z.object({ capacity: amount, bullets: z.number().int().nonnegative().safe() }).strict()
  .refine(gun => gun.bullets <= gun.capacity, "Invalid gun");
export const FlowRouteSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("selection") }).strict(),
  z.object({ type: z.literal("node"), nodeId: id }).strict(),
  z.object({ type: z.literal("finish"), result: FlowResultSchema }).strict()
]);
export const FlowDefinitionSchema = z.object({
  id, playerGun: GunSchema, completionId: id.optional(),
  presentation: z.object({ resultActions: z.enum(["standard", "return"]).optional(), title: id, description: id.optional(), backgroundCharacterId: id.optional(), continueLabel: id.optional(), abandonLabel: id.optional(), comparisonLabel: id.optional() }).strict().optional(),
  nodes: z.array(z.object({
    id, opponentId: id, requires: z.array(id).default([]), repeatable: z.boolean().default(false),
    opponentGun: GunSchema.optional(), victoryRewards: EncounterRewardsSchema.optional(),
    recordResult: z.enum(["terminal", "always", "never"]).optional(),
    presentation: z.object({
      layout: z.enum(["card", "action"]).optional(), tableTitle: id.optional(),
      exit: z.object({ label: id, title: id, hint: id.optional() }).strict().optional(),
      objective: id.optional(), progressLabel: id.optional(), completedLabel: id.optional()
    }).strict().optional(),
    abilities: z.array(z.object({
      slot: id, label: id.optional(), binding: AbilityBindingSchema,
      overrides: z.array(z.object({ afterAny: z.array(id).min(1), binding: AbilityBindingSchema }).strict()).default([])
    }).strict()).optional(),
    routes: z.object({ victory: FlowRouteSchema, defeat: FlowRouteSchema, escaped: FlowRouteSchema }).strict()
  }).strict()).min(1)
}).strict().superRefine((definition, ctx) => {
  const ids = new Set(definition.nodes.map(node => node.id));
  if (ids.size !== definition.nodes.length) ctx.addIssue({ code: "custom", message: "Duplicate flow node" });
  for (const node of definition.nodes) {
    const references = [...node.requires,
      ...Object.values(node.routes).flatMap(route => route.type === "node" ? [route.nodeId] : []),
      ...(node.abilities ?? []).flatMap(slot => slot.overrides.flatMap(override => override.afterAny))];
    if (references.some(reference => !ids.has(reference))) ctx.addIssue({ code: "custom", message: "Unknown flow node reference" });
    if (node.requires.includes(node.id) || new Set(node.requires).size !== node.requires.length)
      ctx.addIssue({ code: "custom", message: "Invalid node prerequisites" });
    const slots = node.abilities?.map(slot => slot.slot) ?? [];
    if (new Set(slots).size !== slots.length) ctx.addIssue({ code: "custom", message: "Duplicate ability slot" });
  }
});
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type FlowNode = FlowDefinition["nodes"][number];
export type FlowRoute = z.infer<typeof FlowRouteSchema>;
const FlowProgressFieldsSchema = z.object({
  id, seed: id, phase: z.enum(["selection", "encounter", "finished"]),
  completedNodes: z.array(id), encounterIndex: z.number().int().nonnegative().safe(),
  encounter: z.object({
    nodeId: id, matchId: id,
    claimedRewards: z.array(EncounterRewardKindSchema).max(3).refine(kinds => new Set(kinds).size === kinds.length, "奖励不能重复领取").optional()
  }).strict().nullable(),
  nextNodeId: id.optional(), result: FlowResultSchema.nullable()
}).strict();
function validateProgress(run: z.infer<typeof FlowProgressFieldsSchema>, ctx: z.RefinementCtx): void {
  if ((run.phase === "encounter") !== (run.encounter !== null) || (run.phase === "finished") !== (run.result !== null))
    ctx.addIssue({ code: "custom", message: "流程阶段与结果不一致" });
  if (run.nextNodeId !== undefined && run.phase !== "selection")
    ctx.addIssue({ code: "custom", path: ["nextNodeId"], message: "仅选择阶段可以指定下一节点" });
  if (new Set(run.completedNodes).size !== run.completedNodes.length)
    ctx.addIssue({ code: "custom", path: ["completedNodes"], message: "流程完成节点不能重复" });
  if (run.completedNodes.length + Number(run.encounter !== null) > run.encounterIndex)
    ctx.addIssue({ code: "custom", path: ["encounterIndex"], message: "流程场次与节点进度不一致" });
}
export const FlowProgressSchema = FlowProgressFieldsSchema.superRefine(validateProgress);
export interface FlowProgress {
  readonly id: string;
  readonly seed: string;
  readonly phase: "selection" | "encounter" | "finished";
  readonly completedNodes: readonly string[];
  readonly encounterIndex: number;
  readonly encounter: { readonly nodeId: string; readonly matchId: string; readonly claimedRewards?: readonly EncounterRewardKind[] } | null;
  readonly nextNodeId?: string;
  readonly result: z.infer<typeof FlowResultSchema> | null;
}
const FlowRunFieldsSchema = FlowProgressFieldsSchema.extend({
  definition: FlowDefinitionSchema, playerGun: GunSchema,
  playerComparisonBonus: z.number().int().nonnegative().safe()
});
const StoredFlowRunFieldsSchema = FlowRunFieldsSchema.extend({ playerGun: GunSchema.optional() });
function validateRun(run: z.infer<typeof StoredFlowRunFieldsSchema>, ctx: z.RefinementCtx): void {
  validateProgress(run, ctx);
  const nodes = new Map(run.definition.nodes.map(node => [node.id, node]));
  if (run.completedNodes.some(nodeId => !nodes.has(nodeId)))
    ctx.addIssue({ code: "custom", path: ["completedNodes"], message: "流程完成进度引用了未知节点" });
  if (run.completedNodes.some(nodeId => nodes.get(nodeId)?.requires.some(required => !run.completedNodes.includes(required))))
    ctx.addIssue({ code: "custom", path: ["completedNodes"], message: "流程完成节点缺少前置进度" });
  const eligible = (node: FlowNode): boolean => (node.repeatable || !run.completedNodes.includes(node.id))
    && node.requires.every(nodeId => run.completedNodes.includes(nodeId));
  if (run.nextNodeId !== undefined) {
    const next = nodes.get(run.nextNodeId);
    if (!next || !eligible(next)) ctx.addIssue({ code: "custom", path: ["nextNodeId"], message: "非法下一流程节点" });
  }
  if (run.encounter) {
    const node = nodes.get(run.encounter.nodeId);
    if (!node || !eligible(node)) ctx.addIssue({ code: "custom", path: ["encounter", "nodeId"], message: "非法当前流程节点" });
    if (run.encounter.claimedRewards?.some(kind => !node?.victoryRewards?.[kind]))
      ctx.addIssue({ code: "custom", path: ["encounter", "claimedRewards"], message: "领取记录引用了不存在的节点奖励" });
  }
}
export const FlowRunSchema = FlowRunFieldsSchema.superRefine(validateRun);
export const StoredFlowRunSchema = StoredFlowRunFieldsSchema.superRefine(validateRun);
export interface FlowRun extends FlowProgress {
  readonly definition: FlowDefinition;
  readonly playerGun: GunState;
  readonly playerComparisonBonus: number;
}
export type StoredFlowRun = Omit<FlowRun, "playerGun"> & { readonly playerGun?: GunState };
