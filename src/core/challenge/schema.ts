import { z } from "zod";
import { AbilityBindingSchema } from "../abilities/schema";

const id = z.string().min(1);
export { EncounterRewardsSchema as ChallengeVictoryRewardsSchema, EncounterRewardKindSchema as ChallengeVictoryRewardKindSchema } from "../flow/schema";
import { EncounterRewardsSchema as ChallengeVictoryRewardsSchema, EncounterRewardKindSchema as ChallengeVictoryRewardKindSchema } from "../flow/schema";
export type { EncounterRewardKind as ChallengeVictoryRewardKind, EncounterRewards as ChallengeVictoryRewards } from "../flow/schema";
export const ChallengeDefinitionSchema = z.object({
  id, name: id, description: id, faction: id,
  unlock: z.discriminatedUnion("type", [
    z.object({ type: z.literal("defeat-count"), count: z.number().int().positive() }).strict(),
    z.object({ type: z.literal("defeat-faction-count"), count: z.number().int().positive().safe() }).strict(),
    z.object({ type: z.literal("defeat-character"), characterId: id }).strict()
  ]),
  bossId: id,
  bossAbilities: z.array(z.object({ slot: id, label: id, binding: AbilityBindingSchema, weakenedBinding: AbilityBindingSchema.optional() }).strict()).min(1),
  guards: z.array(z.object({ characterId: id, suppresses: z.array(id).min(1), description: id, victoryRewards: ChallengeVictoryRewardsSchema.optional() }).strict()).length(4)
}).strict().superRefine((definition, ctx) => {
  const slots = definition.bossAbilities.map(ability => ability.slot);
  const guards = definition.guards.map(guard => guard.characterId);
  if (new Set(slots).size !== slots.length || new Set(guards).size !== 4 || guards.includes(definition.bossId))
    ctx.addIssue({ code: "custom", message: "Boss、四名守卫与技能槽必须唯一" });
  if (definition.guards.some(guard => new Set(guard.suppresses).size !== guard.suppresses.length || guard.suppresses.some(slot => !slots.includes(slot))))
    ctx.addIssue({ code: "custom", message: "守卫削弱引用了未知或重复技能槽" });
});
export type ChallengeDefinition = z.infer<typeof ChallengeDefinitionSchema>;
const gun = z.object({ capacity: z.number().int().positive(), bullets: z.number().int().nonnegative() }).strict().refine(gun => gun.bullets <= gun.capacity);
const ChallengeRunFieldsSchema = z.object({
  id, seed: id, definition: ChallengeDefinitionSchema,
  phase: z.enum(["selection", "encounter", "finished"]),
  defeatedGuards: z.array(id), playerGun: gun, playerComparisonBonus: z.number().int().nonnegative().safe(),
  encounter: z.object({ kind: z.enum(["guard", "boss"]), characterId: id, matchId: id, claimedRewards: z.array(ChallengeVictoryRewardKindSchema).max(3).refine(kinds => new Set(kinds).size === kinds.length, "奖励不能重复领取").optional() }).strict().nullable(),
  encounterIndex: z.number().int().nonnegative(),
  result: z.enum(["victory", "defeat", "abandoned"]).nullable()
}).strict();
function validateRun(run: z.infer<typeof ChallengeRunFieldsSchema> | z.infer<typeof StoredChallengeRunFieldsSchema>, ctx: z.RefinementCtx) {
  const guardIds = run.definition.guards.map(guard => guard.characterId);
  if (run.encounter?.claimedRewards?.some(kind => run.encounter!.kind !== "guard"
    || !run.definition.guards.find(guard => guard.characterId === run.encounter!.characterId)?.victoryRewards?.[kind]))
    ctx.addIssue({ code: "custom", message: "领取记录引用了不存在的守卫奖励" });
  if (new Set(run.defeatedGuards).size !== run.defeatedGuards.length || run.defeatedGuards.some(id => !guardIds.includes(id)))
    ctx.addIssue({ code: "custom", message: "非法守卫进度" });
  if ((run.phase === "encounter") !== (run.encounter !== null) || (run.phase === "finished") !== (run.result !== null))
    ctx.addIssue({ code: "custom", message: "挑战阶段与结果不一致" });
  if (run.encounter && (run.encounter.kind === "boss" ? run.encounter.characterId !== run.definition.bossId : !guardIds.includes(run.encounter.characterId) || run.defeatedGuards.includes(run.encounter.characterId)))
    ctx.addIssue({ code: "custom", message: "非法挑战对手" });
}
export const ChallengeRunSchema = ChallengeRunFieldsSchema.superRefine(validateRun);
export type ChallengeRun = z.infer<typeof ChallengeRunSchema>;
// During an encounter the match owns the gun. A full ChallengeRun is a view,
// reconstructed from that match, never a second mutable copy of its resources.
const StoredChallengeRunFieldsSchema = ChallengeRunFieldsSchema.extend({ playerGun: gun.optional() });
export const StoredChallengeRunSchema = StoredChallengeRunFieldsSchema.superRefine(validateRun);
export type StoredChallengeRun = z.infer<typeof StoredChallengeRunSchema>;
