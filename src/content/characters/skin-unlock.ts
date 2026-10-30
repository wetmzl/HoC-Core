import { z } from "zod";
import type { LongTermSave } from "../../persistence/schema";
import { characterDefeatCount } from "../../persistence/character-defeats";

export type SkinUnlockCondition =
  | { type: "always" }
  | { type: "defeat-character"; count: number; characterId?: string }
  | { type: "completed-challenge"; challengeId: string }
  | { type: "all" | "any"; conditions: SkinUnlockCondition[] };

function conditionSchema(depth: number): z.ZodType<SkinUnlockCondition> {
  const leaf = [
    z.object({ type: z.literal("always") }).strict(),
    z.object({ type: z.literal("defeat-character"), count: z.number().int().positive().safe(), characterId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional() }).strict(),
    z.object({ type: z.literal("completed-challenge"), challengeId: z.string().min(1).max(256) }).strict()
  ];
  return z.union(depth === 0 ? leaf : [...leaf,
    z.object({ type: z.enum(["all", "any"]), conditions: z.array(conditionSchema(depth - 1)).min(1).max(16) }).strict()
  ]) as z.ZodType<SkinUnlockCondition>;
}

export const SkinUnlockConditionSchema = conditionSchema(6).superRefine((value, ctx) => {
  let nodes = 0;
  const visit = (rule: SkinUnlockCondition): void => {
    nodes++;
    if (rule.type === "all" || rule.type === "any") rule.conditions.forEach(visit);
  };
  visit(value);
  if (nodes > 128) ctx.addIssue({ code: "custom", message: "皮肤解锁条件不得超过128项" });
});

export function skinUnlockConditionMet(save: LongTermSave, characterId: string, condition: SkinUnlockCondition): boolean {
  switch (condition.type) {
    case "always": return true;
    case "defeat-character": return characterDefeatCount(save, condition.characterId ?? characterId) >= condition.count;
    case "completed-challenge": return save.completedChallenges?.includes(condition.challengeId) ?? false;
    case "all": return condition.conditions.every(rule => skinUnlockConditionMet(save, characterId, rule));
    case "any": return condition.conditions.some(rule => skinUnlockConditionMet(save, characterId, rule));
  }
}

export function skinUnlockConditionLabel(condition: SkinUnlockCondition): string {
  switch (condition.type) {
    case "always": return "自动解锁";
    case "defeat-character": return `击败${condition.characterId ? "指定角色" : "该角色"} ${condition.count} 次解锁`;
    case "completed-challenge": return "完成指定挑战后解锁";
    case "all": return condition.conditions.map(skinUnlockConditionLabel).join("，并且");
    case "any": return condition.conditions.map(skinUnlockConditionLabel).join("，或");
  }
}
